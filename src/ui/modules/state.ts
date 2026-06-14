/*
   Copyright 2026 kanreisa

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
import { EventEmitter } from "eventemitter3";
import { DateTime } from "luxon";
import { useNavigate, useLocation } from "react-router-dom";
import { Client as RPCClient } from "jsonrpc2-ws";
import { setSchedule } from "./at";
import * as ui from "./ui";
import { Event, Service, Program, TunerDevice, Status, JobItem, JobScheduleItem, ConfigServer } from "../../../api.d";
import { JoinParams, NotifyParams } from "../../../lib/Mirakurun/rpc.d";

type StatusIconKey = "normal" | "offline" | "active";

type StateEventTypes = {
    "todayTime": [number];
    "statusName": [string];
    "statusIconKey": [StatusIconKey];
    "version": [string];
    "status": [Status];
    "services": [Service[]];
    "tuners": [TunerDevice[]];
    "jobs": [JobItem[]];
    "jobSchedules": [JobScheduleItem[]];
    "programs": [Program[]];
    "logs": [string[], boolean];
};

import normalIcon from "../icon.svg";
import offlineIcon from "../icon-gray.svg";
import activeIcon from "../icon-active.svg";
const iconSrcMap = {
    normal: normalIcon,
    offline: offlineIcon,
    active: activeIcon
};

const jobStatusOrderMap = {
    queued: 0,
    standby: 1,
    running: 2,
    finished: 3
};

class State extends EventEmitter<StateEventTypes> {
    isDev: boolean = /^\/dev\/.*$/.test(location.pathname);

    navigate?: ReturnType<typeof useNavigate>;
    location?: ReturnType<typeof useLocation>;
    pathname?: string;
    searchParams?: URLSearchParams;

    todayTime?: number;

    version = "..";
    statusName = "Loading";
    statusIconKey: StatusIconKey = "offline";

    status?: Status;
    services: Service[] = [];
    tuners: TunerDevice[] = [];
    jobs: JobItem[] = [];
    jobSchedules: JobScheduleItem[] = [];
    programs: Program[] = [];
    serverConfig?: ConfigServer;

    private _rpc?: RPCClient;

    constructor() {
        super();

        if (!this.isDev) {
            const emptyFunction = function () {};
            if (console?.debug) {
                console.debug = emptyFunction;
            }
            if (console?.log) {
                console.log = emptyFunction;
            }
        }

        this._setTodayTime();
        this._initRPC();

        this.on("tuners", () => this._updateIdleStatus());
        this.on("statusIconKey", key => ui.setFavicon(iconSrcMap[key]));
    }

    get statusIconSrc() {
        return iconSrcMap[this.statusIconKey];
    }

    async fetchStatus(): Promise<Status> {
        this.status = await this._rpc.call("getStatus");
        this.emit("status", this.status);

        // version
        if (this.version !== ".." && this.version !== this.status.version) {
            location.reload();
            return;
        }
        this.version = this.status.version;
        this.emit("version", this.version);

        return this.status;
    }

    async fetchServices(): Promise<Service[]> {
        this.services = await this._rpc.call("getServices");
        if (this.services.length > 0) {
            this.emit("services", this.services);
        }
        return this.services;
    }

    async fetchTuners(): Promise<TunerDevice[]> {
        this.tuners.splice(0, this.tuners.length, ...await this._rpc.call("getTuners"));
        if (this.jobs.length > 0) {
            this.emit("tuners", this.tuners);
        }
        return this.tuners;
    }

    async fetchJobs(): Promise<JobItem[]> {
        this.jobs.splice(0, this.jobs.length, ...await this._rpc.call("getJobs"));
        if (this.jobs.length > 0) {
            this._handleJobs();
            this.emit("jobs", this.jobs);
        }
        return this.jobs;
    }

    async fetchJobSchedules(): Promise<JobScheduleItem[]> {
        this.jobSchedules = await this._rpc.call("getJobSchedules");
        if (this.jobSchedules.length > 0) {
            this.emit("jobSchedules", this.jobSchedules);
        }
        return this.jobSchedules;
    }

    async fetchPrograms(): Promise<Program[]> {
        this.programs = await (await fetch("/api/programs")).json();
        if (this.programs.length > 0) {
            this.emit("programs", this.programs);
        }
        return this.programs;
    }

    private _joinProgramEvents: () => void;
    async subscribePrograms(forceEmit = false): Promise<void> {
        if (this._joinProgramEvents) {
            if (forceEmit) {
                this.emit("programs", this.programs);
            }
            return;
        }
        this._joinProgramEvents = () => {
            this.fetchPrograms();
            this._rpc.call("join", {
                rooms: ["events:program"],
            } as JoinParams);
        };

        this._rpc.on("connected", this._joinProgramEvents);

        if (this._rpc.isConnected()) {
            this._joinProgramEvents();
        }
    }

    async unsubscribePrograms(): Promise<void> {
        if (this._rpc.isConnected()) {
            this._rpc.call("leave", {
                rooms: ["events:program"],
            } as JoinParams);
        }

        if (this._joinProgramEvents) {
            this._rpc.off("connected", this._joinProgramEvents);
            this._joinProgramEvents = undefined;
        }
    }

    async fetchServerConfig(): Promise<ConfigServer> {
        this.serverConfig = await (await fetch("/api/config/server")).json();
        return this.serverConfig;
    }

    private _setTodayTime() {
        console.debug("state", "setTodayTime()");

        const init = !this.todayTime;

        this.todayTime = DateTime.now().startOf("day").toMillis();

        if (!init) {
            this.emit("todayTime", this.todayTime);
        }

        // update daily
        setSchedule(this.todayTime + 86400000, () => this._setTodayTime());
    }

    private _initRPC() {
        const rpc = this._rpc = new RPCClient(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc`, {
            protocols: null,
            bufferSendingMessages: false
        });

        rpc.on("connecting", () => {
            console.debug("rpc:connecting");

            this.statusName = "Connecting";
            this.statusIconKey = "offline";
            this.emit("statusName", this.statusName);
            this.emit("statusIconKey", this.statusIconKey);
        });

        let _statusRefreshInterval: NodeJS.Timeout | undefined;
        rpc.on("connected", async () => {
            console.debug("rpc:connected");

            this.programs = [];

            this.statusName = "Connected";
            this.statusIconKey = "normal";
            this.emit("statusName", this.statusName);
            this.emit("statusIconKey", this.statusIconKey);

            await rpc.call("join", {
                rooms: [
                    "events:service",
                    "events:tuner",
                    "events:job",
                    "events:job_schedule"
                ],
            } as JoinParams);

            await this.fetchStatus();
            await this.fetchServices();
            await this.fetchTuners();
            await this.fetchJobs();
            await this.fetchJobSchedules();
        });

        rpc.on("disconnect", () => {
            console.debug("rpc:disconnected");

            if (_statusRefreshInterval) {
                clearInterval(_statusRefreshInterval);
                _statusRefreshInterval = undefined;
            }

            this.statusName = "Disconnected";
            this.statusIconKey = "offline";
            this.emit("statusName", this.statusName);
            this.emit("statusIconKey", this.statusIconKey);
        });

        rpc.methods.set("events", async (socket, { array }: NotifyParams<Event>) => {
            let programsUpdated = false;
            let servicesUpdated = false;
            let tunersUpdated = false;
            let jobsUpdated = false;
            let jobSchedulesUpdated = false;

            for (const event of array) {
                switch (event.resource) {
                    case "program": {
                        const program = event.data as Program;
                        const index = this.programs.findIndex(p => p.id === program.id);
                        if (event.type === "remove") {
                            if (index !== -1) {
                                this.programs.splice(index, 1);
                            }
                        } else {
                            if (index === -1) {
                                this.programs.push(program);
                            } else {
                                this.programs.splice(index, 1, program);
                            }
                        }
                        programsUpdated = true;
                        break;
                    }
                    case "service": {
                        const service = event.data as Service;
                        const index = this.services.findIndex(s => s.id === service.id);
                        if (index === -1) {
                            this.services.push(service);
                        } else {
                            this.services[index] = {
                                ...this.services[index],
                                ...service
                            };
                        }
                        servicesUpdated = true;
                        break;
                    }
                    case "tuner": {
                        const tuner = event.data as TunerDevice;
                        this.tuners[this.tuners.findIndex(value => value.index === tuner.index)] = tuner;
                        tunersUpdated = true;
                        break;
                    }
                    case "job": {
                        const job = event.data as JobItem;
                        const index = this.jobs.findIndex(j => j.id === job.id);
                        if (index === -1) {
                            this.jobs.unshift(job);
                        } else {
                            this.jobs.splice(index, 1, job);
                        }
                        jobsUpdated = true;
                        break;
                    }
                    case "job_schedule": {
                        const jobSchedule = event.data as JobScheduleItem;
                        const index = this.jobSchedules.findIndex(j => j.key === jobSchedule.key);
                        if (index === -1) {
                            this.jobSchedules.push(jobSchedule);
                        } else {
                            this.jobSchedules.splice(index, 1, jobSchedule);
                        }
                        jobSchedulesUpdated = true;
                        break;
                    }
                }
            }

            if (programsUpdated) {
                this.emit("programs", this.programs);
            }
            if (servicesUpdated) {
                this.emit("services", this.services);
            }
            if (tunersUpdated) {
                this.emit("tuners", this.tuners);
            }
            if (jobsUpdated) {
                this._handleJobs();
                this.emit("jobs", this.jobs);
            }
            if (jobSchedulesUpdated) {
                this.emit("jobSchedules", this.jobSchedules);
            }
        });

        // ログイベントの処理
        rpc.methods.set("logs", async (socket, { array }: NotifyParams<string>) => {
            // 配列から文字列を抽出し、unshift=false（末尾に追加）でイベントを発行
            this.emit("logs", array, false);
        });
    }

    private _handleJobs() {
        this.jobs.sort((a, b) => {
            if (a.status === b.status) {
                if (a.finishedAt && b.finishedAt) {
                    return b.finishedAt - a.finishedAt;
                }
                if (a.startedAt && b.startedAt) {
                    return b.startedAt - a.startedAt;
                }
                if (a.createdAt && b.createdAt) {
                    return b.createdAt - a.createdAt;
                }
                return b.id.localeCompare(a.id);
            }
            return jobStatusOrderMap[a.status] - jobStatusOrderMap[b.status];
        });

        // drop old jobs
        if (this.jobs.length > 200) {
            this.jobs.splice(200, this.jobs.length - 200);
        }
    }

    private _updateIdleStatus() {
        let statusName = "Standby";
        let statusIconKey: StatusIconKey = "normal";

        const isActive = this.tuners.some(tuner => tuner.isUsing === true && tuner.users.some(user => user.priority !== -1));
        if (isActive) {
            statusName = "Active";
            statusIconKey = "active";
        }

        if (this.statusName !== statusName) {
            this.statusName = statusName;
            this.statusIconKey = statusIconKey;
            this.emit("statusName", this.statusName);
            this.emit("statusIconKey", this.statusIconKey);
        }
    }
}

export const state = new State();
