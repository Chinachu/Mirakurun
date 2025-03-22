/*
   Copyright 2016 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import * as os from "os";
import * as log from "./log";
import { sleep } from "./common";

export interface JobFnOptions {
    signal: AbortSignal;
}

export type JobFn = (options: JobFnOptions) => Promise<any>;

export type ReadyFn = () => Promise<boolean>;

export interface JobItem {
    key: string;
    name: string;
    fn: JobFn;
    /** if return `false`, skip call fn */
    readyFn?: ReadyFn;

    /** リトライするかどうか - abort時 */
    retryOnAbort?: boolean;
    /** リトライするかどうか - 失敗時 */
    retryOnFail?: boolean;
    /** 最大リトライ回数。設定されていない場合はリトライしない */
    retryMax?: number;
    /**
     * リトライ間の待機時間（ミリ秒）
     * @type {number} retry delay in milliseconds. (integer)
     * @default 1000
     */
    retryDelay?: number;
}

export interface QueuedJobItem extends JobItem {
    id: string;
    retryCount: number;
    createdAt: number;
}

export interface RunningJobItem extends QueuedJobItem {
    ac: AbortController;
    startedAt: number;
}

export interface PastJobItem extends Omit<RunningJobItem, "ac"> {
    ok: boolean;
    hasAborted: boolean;
    hasSkipped: boolean;
    hasFailed: boolean;
    finishedAt: number;
    error?: Error;
}

export interface ScheduleItem {
    key: string;
    job: JobItem;
    /**
     * crontab like format.
     * `m h dom mon dow`
     * ```
     * ┌───────────── minute (0..59)
     * │ ┌───────────── hour (0..23)
     * │ │ ┌───────────── day of month (1..31)
     * │ │ │ ┌───────────── month (1..12)
     * │ │ │ │ ┌───────────── day of week (0..6) <sun..sat>
     * * * * * *
     * ```
     * @example "0 0 * * *"
     */
    schedule: string;
}

export class Job {
    maxRunning: number = Math.max(1, Math.floor(os.cpus().length / 2)); // todo: config
    maxStandby: number = Math.max(1, Math.floor(os.cpus().length - 1)); // 同時に ready チェックを行う最大数
    maxHistory: number = 50; // todo: config

    private _jobIdPrefix = Date.now().toString(36).toUpperCase() + ".";
    private _jobIdCounter = 0;
    private _queuedJobItems: QueuedJobItem[] = [];
    private _standbyJobItems: QueuedJobItem[] = [];
    private _runningJobItemSet: Set<RunningJobItem> = new Set();
    private _scheduleItemSet: Set<ScheduleItem> = new Set();
    private _pastJobItems: PastJobItem[] = [];
    private _scheduleInterval: NodeJS.Timeout;
    private _queueCheckTimeout: NodeJS.Timeout | null = null;

    constructor() {
        this._scheduleInterval = setInterval(() => this._checkSchedule(), 1000 * 60);
    }

    get queuedJobItems(): QueuedJobItem[] {
        return this._queuedJobItems;
    }

    get standbyJobItems(): QueuedJobItem[] {
        return this._standbyJobItems;
    }

    get runningJobItems(): RunningJobItem[] {
        return Array.from(this._runningJobItemSet).map(job => {
            // acプロパティを除いた新しいオブジェクトを作成し、型安全性を確保
            const { ac, ...jobWithoutAc } = job;
            return {
                ...jobWithoutAc,
                ac: undefined as unknown as AbortController
            };
        });
    }

    get pastJobItems(): PastJobItem[] {
        return [...this._pastJobItems];
    }

    close(): void {
        clearInterval(this._scheduleInterval);

        if (this._queueCheckTimeout) {
            clearTimeout(this._queueCheckTimeout);
            this._queueCheckTimeout = null;
        }

        // Abort all running jobs
        for (const job of this._runningJobItemSet) {
            job.ac.abort();
        }
    }

    add(jobItem: JobItem, _retryCount = 0): void {
        log.info(`Job#add() adding "${jobItem.key}"`);

        // ignore duplicated job by key
        for (const job of [...this._queuedJobItems, ...this._standbyJobItems, ...this._runningJobItemSet]) {
            if (job.key === jobItem.key) {
                log.warn(`Job#add() ignore adding "${jobItem.key}" because already in the queue or running.`);
                return;
            }
        }

        this._queuedJobItems.push({
            ...jobItem,
            id: this._jobIdPrefix + (++this._jobIdCounter),
            createdAt: Date.now(),
            retryCount: _retryCount
        });

        this._checkQueue();
    }

    abort(id: string): boolean {
        for (const job of this._runningJobItemSet) {
            if (job.id === id) {
                job.ac.abort();
                log.info(`Job#abort() abort requested "${job.key}" (id: ${job.id})`);
                return true;
            }
        }
        return false;
    }

    addSchedule(schedule: ScheduleItem): void {
        // ignore duplicated schedule by key
        for (const job of this._scheduleItemSet) {
            if (job.key === schedule.key) {
                log.warn(`Job#addSchedule() ignore adding "${schedule.key}" because already in the schedule.`);
                return;
            }
        }

        log.info(`Job#addSchedule() adding "${schedule.key}"`);

        this._scheduleItemSet.add(schedule);
    }

    /**
     * if not found, return false
     */
    runSchedule(scheduleJobKey: string): boolean {
        for (const schedule of this._scheduleItemSet) {
            if (schedule.key === scheduleJobKey) {
                this.add(schedule.job);
                return true;
            }
        }

        log.warn(`Job#runSchedule() "${scheduleJobKey}" not found in schedule`);
        return false;
    }

    private async _checkSchedule(): Promise<void> {
        const date = new Date();

        const invalidJobs = new Set<ScheduleItem>();

        for (const schedule of this._scheduleItemSet) {
            try {
                if (matchCronExpression(schedule.schedule, date)) {
                    // スケジュールされたジョブを追加する前にリトライカウントをリセット
                    const job = { ...schedule.job, retryCount: 0 };
                    this.add(job);
                }
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                log.error(`Job#_checkSchedule() ${schedule.key} err=${error.message}`);
                invalidJobs.add(schedule);
            }
        }

        // Remove invalid jobs
        for (const job of invalidJobs) {
            this._scheduleItemSet.delete(job);
        }
    }

    private _checkQueue(): void {
        log.debug(`Job#_checkQueue() queue=${this._queuedJobItems.length} standby=${this._standbyJobItems.length} running=${this._runningJobItemSet.size}`);

        if (this._standbyJobItems.length >= this.maxStandby) {
            log.debug("Job#_checkQueue() standby is full [skip]");
            return;
        }
        if (this._queuedJobItems.length === 0) {
            log.debug("Job#_checkQueue() queue is empty [skip]");
            return;
        }

        for (const job of this._queuedJobItems) {
            if (this._standbyJobItems.length >= this.maxStandby) {
                break;
            }

            this._checkReady(job);
        }
    }

    private async _checkReady(job: QueuedJobItem): Promise<void> {
        log.debug(`Job#_checkReady() checking "${job.key}" (id: ${job.id})`);

        if (!this._queuedJobItems.includes(job)) {
            log.error(`Job#_checkReady() "${job.key}" (id: ${job.id}) not found in queue`);
            return;
        }
        if (this._standbyJobItems.includes(job)) {
            log.error(`Job#_checkReady() "${job.key}" (id: ${job.id}) already in standby`);
            return;
        }
        if (this._standbyJobItems.length >= this.maxStandby) {
            log.error(`Job#_checkReady() "${job.key}" (id: ${job.id}) standby is full`);
            return;
        }

        const index = this._queuedJobItems.indexOf(job);
        if (index !== -1) {
            this._queuedJobItems.splice(index, 1);
        }
        this._standbyJobItems.push(job);

        let skip = false;

        if (job.readyFn) {
            try {
                skip = await job.readyFn() === false;
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                log.error(`Job#_checkReady() "${job.key}" readyFn error: ${error.message}`);
                skip = true;
            }
        }

        if (!skip && this._runningJobItemSet.size >= this.maxRunning) {
            log.debug(`Job#_checkReady() running is full [wait]`);
            while (this._runningJobItemSet.size >= this.maxRunning) {
                await sleep(1000);
            }
        }

        const waitingIndex = this._standbyJobItems.indexOf(job);
        if (waitingIndex !== -1) {
            this._standbyJobItems.splice(waitingIndex, 1);
        }

        if (skip) {
            // skip
            const skippedJob: RunningJobItem = {
                ...job,
                ac: new AbortController(),
                retryCount: job.retryCount || 0, // 既存のリトライカウントを使用
                startedAt: Date.now()
            };
            skippedJob.ac.abort("skipped");

            log.debug(`Job#_checkReady() skipped "${job.key}" (id: ${job.id}) due to readyFn returning false`);
            this._finishJob(skippedJob, true);
        } else {
            // run
            const runningJob: RunningJobItem = {
                ...job,
                ac: new AbortController(),
                retryCount: job.retryCount || 0, // 既存のリトライカウントを使用
                startedAt: Date.now()
            };
            this._run(runningJob);
        }

        log.debug(`Job#_checkReady() done "${job.key}" (id: ${job.id})`);

        clearTimeout(this._queueCheckTimeout);
        this._queueCheckTimeout = setTimeout(() => this._checkQueue(), 1000);
    }

    private async _run(job: RunningJobItem): Promise<void> {
        log.debug(`Job#_run() starting "${job.key}" (id: ${job.id})`);

        if (this._runningJobItemSet.has(job)) {
            log.error(`Job#_run() "${job.key}" (id: ${job.id}) already running`);
            return;
        }
        if (this._runningJobItemSet.size >= this.maxRunning) {
            log.error(`Job#_run() "${job.key}" (id: ${job.id}) running is full`);
            return;
        }

        this._runningJobItemSet.add(job);

        try {
            await job.fn({ signal: job.ac.signal });
            this._finishJob(job, true);
        } catch (error) {
            this._finishJob(job, false, error);
            setImmediate(() => this._retryJob(job));
        }

        this._runningJobItemSet.delete(job);

        log.debug(`Job#_run() done "${job.key}" (id: ${job.id})`);
    }

    private _finishJob(job: RunningJobItem, ok: boolean, error?: Error): void {
        const finishedAt = Date.now();
        const hasAborted = job.ac.signal.aborted;
        const hasSkipped = job.ac.signal.aborted && job.ac.signal.reason === "skipped";
        const hasFailed = !ok;

        // Add to history
        const pastJob: PastJobItem = {
            ...job,
            ok,
            hasAborted,
            hasSkipped,
            hasFailed,
            finishedAt,
            error
        };
        this._pastJobItems.unshift(pastJob);

        // 最大履歴数を超える古い履歴を削除
        if (this._pastJobItems.length > this.maxHistory) {
            this._pastJobItems.length = this.maxHistory;
        }

        const duration = finishedAt - job.startedAt;
        const statusMsg = ok ? "completed" : "failed";
        const abortMsg = hasAborted ? " (aborted)" : "";
        log.info(`Job#_finishJob() "${job.key}" ${statusMsg}${abortMsg} in ${duration}ms`);
    }

    private async _retryJob(job: RunningJobItem): Promise<void> {
        // リトライすべきかどうかを確認
        const shouldRetryOnAbort = job.retryOnAbort === true && job.ac.signal.aborted;
        const shouldRetryOnFail = job.retryOnFail === true && !job.ac.signal.aborted;
        const retryMax = job.retryMax !== undefined ? job.retryMax : 0;
        const nextRetryCount = job.retryCount + 1;
        const canRetry = nextRetryCount <= retryMax;

        if ((shouldRetryOnAbort || shouldRetryOnFail) && canRetry) {
            const retryDelay = Math.max(1000, job.retryDelay || 1000);

            log.warn(`Job#_handleJobError() "${job.key}" will retry (${nextRetryCount}/${retryMax}) after ${retryDelay}ms`);

            // todo: 1度限りのスケジュール実行を実装して移行する
            // Wait before retrying
            await sleep(retryDelay);

            // Add new job to queue
            this.add({
                key: job.key,
                name: job.name,
                fn: job.fn,
                readyFn: job.readyFn,
                retryOnAbort: job.retryOnAbort,
                retryOnFail: job.retryOnFail,
                retryMax: job.retryMax,
                retryDelay: job.retryDelay
            }, nextRetryCount);
        }
    }
}

function matchCronExpression(cronExpression: string, date: Date): boolean {
    const parts = cronExpression.split(" ");
    if (parts.length !== 5) {
        throw new Error(`Invalid schedule format: ${cronExpression}`);
    }

    const [minStr, hourStr, domStr, monStr, dowStr] = parts;
    const dateMin = date.getMinutes();
    const dateHour = date.getHours();
    const dateDom = date.getDate();
    const dateMon = date.getMonth() + 1;
    const dateDow = date.getDay();

    // Parse each part of the cron expression
    const matchesMinute = matchCronPart(minStr, dateMin, 0, 59);
    const matchesHour = matchCronPart(hourStr, dateHour, 0, 23);
    const matchesDOM = matchCronPart(domStr, dateDom, 1, 31);
    const matchesMON = matchCronPart(monStr, dateMon, 1, 12);
    const matchesDOW = matchCronPart(dowStr, dateDow, 0, 6);

    return matchesMinute && matchesHour && matchesDOM && matchesMON && matchesDOW;
}

function matchCronPart(cronPart: string, value: number, min: number, max: number): boolean {
    // Handle wildcard
    if (cronPart === "*") {
        return true;
    }

    const values = new Set<number>();

    // Process parts separated by commas
    for (const part of cronPart.split(",")) {
        if (part.includes("/")) {
            // Handle steps (e.g. */5)
            const [range, step] = part.split("/");
            const stepNum = parseInt(step, 10);

            if (isNaN(stepNum) || stepNum <= 0) {
                throw new Error(`Invalid step value: ${step}`);
            }

            let start = min;
            let end = max;

            // Handle ranges with steps (e.g. 1-10/2)
            if (range !== "*" && range.includes("-")) {
                const [rangeStart, rangeEnd] = range.split("-").map(v => parseInt(v, 10));

                if (isNaN(rangeStart) || isNaN(rangeEnd) || rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
                    throw new Error(`Invalid range with step: ${part}`);
                }

                start = rangeStart;
                end = rangeEnd;
            }

            for (let i = start; i <= end; i++) {
                if ((i - start) % stepNum === 0) {
                    values.add(i);
                }
            }
        } else if (part.includes("-")) {
            // Handle ranges (e.g. 1-5)
            const [start, end] = part.split("-").map(v => parseInt(v, 10));

            if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
                throw new Error(`Invalid range: ${part}`);
            }

            for (let i = start; i <= end; i++) {
                values.add(i);
            }
        } else {
            // Handle single values
            const num = parseInt(part, 10);

            if (isNaN(num) || num < min || num > max) {
                throw new Error(`Invalid value: ${part}`);
            }

            values.add(num);
        }
    }

    return values.has(value);
}

export default Job;
