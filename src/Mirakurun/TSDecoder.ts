/*
   Copyright 2021 kanreisa

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
import * as stream from "stream";
import * as child_process from "child_process";
import * as log from "./log";
import { parseCommandForSpawn } from "./command";
import status from "./status";

interface StreamOptions extends stream.TransformOptions {
    readonly output: stream.Writable;
    readonly command: string;
    /** `true` to split the command into the arguments (for the TLV decoders) */
    readonly withArgs?: boolean;
    /** milliseconds to wait for the first output (default: 1500) */
    readonly startupTimeout?: number;
    /** `false` to close the stream instead of passing through the input when the process keeps failing (default: `true`) */
    readonly passThroughOnFailure?: boolean;
}

const END_DRAIN_TIMEOUT_MS = 5000;
let idCounter = 0;

export default class TSDecoder extends stream.Writable {
    // output
    private _output: stream.Writable;

    private _id: number;
    private _command: string;
    private _withArgs: boolean;
    private _startupTimeout: number;
    private _passThroughOnFailure: boolean;
    private _process: child_process.ChildProcess;
    private _readable: stream.Readable;
    private _writable: stream.Writable;
    private _handleData: (chunk: Buffer) => void;
    private _releaseInput: () => void;

    private _isNew: boolean = false;
    private _timeout: NodeJS.Timeout;
    private _respawnTimeout: NodeJS.Timeout;
    private _endTimeout?: NodeJS.Timeout;
    private _closed: boolean = false;
    private _deadCount: number = 0;
    private _startup: Promise<void> = Promise.resolve();
    private readonly _handleOutputClose: () => void;
    private readonly _handleOutputDrain: () => void;
    private readonly _handleInputDrain: () => void;
    private _drainPending = false;
    private _drainScheduled = false;

    constructor(opts: StreamOptions) {
        super();
        this._handleOutputClose = this._close.bind(this);
        this._handleOutputDrain = () => this._notifyDrain();
        this._handleInputDrain = () => {
            // Node自身がdrainを送った場合は、容量監視による通知を重ねない。
            if (this.writableLength < this.writableHighWaterMark) { this._drainPending = false; }
        };
        this.prependListener("drain", this._handleInputDrain);

        this._id = idCounter++;
        this._command = opts.command;
        this._withArgs = opts.withArgs === true;
        this._startupTimeout = opts.startupTimeout || 1500;
        this._passThroughOnFailure = opts.passThroughOnFailure !== false;

        this._output = opts.output;
        this._output.once("finish", this._handleOutputClose);
        this._output.once("close", this._handleOutputClose);
        this._output.on("drain", this._handleOutputDrain);

        // 出力の容量はそのまま使い、入力queue・stdinは各段自身の上限で背圧を判定する。
        const getInputLength = Object.getOwnPropertyDescriptor(stream.Writable.prototype, "writableLength")!.get!;
        const inputHighWaterMark = this.writableHighWaterMark;
        Object.defineProperty(this, "writableLength", {
            get: () => {
                const inputBlocked = getInputLength.call(this) >= inputHighWaterMark ||
                    this._writable !== undefined && this._writable.writableLength >= this._writable.writableHighWaterMark;
                // 公開値は出力の単位へそろえる。decoder連鎖でも最小HWMで出力容量を縮めない。
                const length = inputBlocked ? Math.max(opts.output.writableLength, opts.output.writableHighWaterMark) : opts.output.writableLength;
                // filterはwrite()の戻り値以外でも待機する。満杯を観測したときだけ再開通知を補う。
                if (length >= opts.output.writableHighWaterMark) { this._drainPending = true; }
                return length;
            }
        });
        Object.defineProperty(this, "writableHighWaterMark", {
            get: () => opts.output.writableHighWaterMark
        });

        this.once("close", this._close.bind(this));

        log.info("TSDecoder#%d has created (command=%s)", this._id, this._command);

        ++status.streamCount.decoder;

        try {
            this._spawn();
        } catch (error) {
            this._close(false);
            throw error;
        }
    }

    _write(chunk: Buffer, encoding: string, callback: Function) {
        if (!this._writable) {
            callback();
            return;
        }

        if (this._isNew === true && this._process) {
            this._isNew = false;
            this._timeout = setTimeout(() => {
                log.warn("TSDecoder#%d process will force killed because no respond...", this._id);
                // 35669ceの待機時間を維持し、B25/TSもTLV変換も2回のタイムアウトで上限にする。
                // 4.3.0では強制終了後のcloseも失敗に数えていた分を明示し、同じ子のcloseは再加算しない。
                ++this._deadCount;
                this._dead();
            }, this._startupTimeout);
        }

        const writable = this._writable;
        if (writable.write(chunk)) {
            callback();
        } else {
            // drain前の次の_writeを止める。終了・再起動でも待機を解除し、古い子へ再送しない。
            const release = () => {
                if (this._releaseInput !== release) { return; }
                this._releaseInput = undefined;
                writable.removeListener("drain", release);
                callback();
                this._notifyDrain();
            };
            this._releaseInput = release;
            writable.once("drain", release);
        }
    }

    /** cork()した入力もstdinの上限で区切り、drain後に残りを順番に渡す。 */
    _writev(chunks: { chunk: Buffer }[], callback: Function) {
        let index = 0;
        const write = () => {
            // fallback後の継続は、新しい出力先へ未送信分だけを渡す。終了・再起動中は破棄する。
            const writable = this._writable;
            if (this._closed || !writable) { callback(); return; }
            let waiting = false;
            writable.cork();
            try {
                while (index < chunks.length) {
                    let synchronous = true;
                    let completed = false;
                    this._write(chunks[index++].chunk, "buffer", () => {
                        completed = true;
                        if (!synchronous) { write(); }
                    });
                    synchronous = false;
                    if (!completed) { waiting = true; break; }
                }
            } finally { writable.uncork(); }
            if (!waiting) { callback(); }
        };
        write();
    }

    end(callback?: () => void): this;
    end(chunk: unknown, callback?: () => void): this;
    end(chunk: unknown, encoding: BufferEncoding, callback?: () => void): this;
    end(chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): this {
        // 引数不正で拒否された要求では、稼働中の配信に終了期限を設定しない。
        const result = super.end(chunk, encoding as BufferEncoding, callback);
        // drain待ちがあると_final自体に到達しないため、受理した終了要求に対して期限を固定する。
        // 通常の入力はそのまま順に処理し、期限切れだけ既存のcloseで待機と子プロセスを解放する。
        if (!this._closed && this._endTimeout === undefined) {
            this._endTimeout = setTimeout(() => {
                log.warn("TSDecoder#%d ⚠️ 終了要求後も入力の処理が完了しないため、デコーダーを終了します (timeout=%dms)", this._id, END_DRAIN_TIMEOUT_MS);
                this._close();
            }, END_DRAIN_TIMEOUT_MS);
        }
        return result;
    }

    _final() {
        // end()/close()は受信の停止要求として扱い、子のEOF出力を待たずに既存の即時停止を維持する。
        // 子の内部に残る未出力データは保存を保証しない。入力のdrain待ちにはend()の5秒上限を適用する。
        this._close();
    }

    // 準備に失敗した所有者は、出力先を終了せずdecoderの資源だけを解放できる。
    close(endOutput = true): void {
        this._close(endOutput);
    }

    /** 子プロセスの起動失敗を、配信開始の確定前に呼出元へ返します。 */
    async waitForStart(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (!signal) { return this._startup; }
        let abort: () => void;
        try {
            await Promise.race([this._startup, new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
            })]);
        } finally { signal.removeEventListener("abort", abort); }
    }

    /**
     * 各段の空きを確認し、write callbackや下流drainの途中へ再入せずに上流を再開する。
     */
    private _notifyDrain(): void {
        if (this._closed || !this._drainPending || this._drainScheduled) { return; }
        this._drainScheduled = true;
        queueMicrotask(() => {
            this._drainScheduled = false;
            // 再起動中や終了中にflushを進めて、保留分を入力先のない状態で破棄しない。
            if (this._closed || this.writableEnded || this.destroyed || this._output.writableEnded || this._output.destroyed ||
                !this._writable || !this._drainPending ||
                this.writableLength >= this.writableHighWaterMark) { return; }
            this._drainPending = false;
            this.emit("drain");
        });
    }

    private _spawn(): void {
        if (this._closed === true || this._process) {
            return;
        }
        if (this._deadCount > 0) {
            ++status.errorCount.decoderRespawn;
            log.warn("TSDecoder#%d respawning because dead (count=%d)", this._id, this._deadCount);
        }

        const restarting = this._deadCount > 0;
        let resolveStart: () => void;
        let rejectStart: (error: Error) => void;
        this._startup = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
        // 単独のdecoder利用側が待機しなくても、起動失敗を未処理rejectionにしない。
        void this._startup.catch(() => undefined);
        let failedToStart = false;
        const failStart = (cause: unknown): Error => {
            const failure = Object.assign(new Error("decoder process could not be started"), {
                code: "ERR_DECODER_START_FAILED", cause
            });
            rejectStart(failure);
            if (failedToStart || this._closed) { return failure; }
            failedToStart = true;
            const errno = (cause as NodeJS.ErrnoException)?.code;
            log.error("TSDecoder#%d process could not be started (command=%s, code=ERR_DECODER_START_FAILED, errno=%s)",
                this._id, this._command, typeof errno === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(errno) ? errno : "unknown");
            // 初回は出力を閉じずに開始処理へ返す。稼働後の起動失敗は従来の有限再試行へ渡す。
            if (restarting) { this._dead(false); } else { this._close(false); }
            return failure;
        };
        let proc: child_process.ChildProcessWithoutNullStreams;
        try {
            const parsed = this._withArgs ? parseCommandForSpawn(this._command) : { command: this._command, args: [] };
            proc = this._process = child_process.spawn(parsed.command, parsed.args);
        } catch (cause) {
            const failure = failStart(cause);
            if (!restarting) { throw failure; }
            return;
        }
        let started = proc.pid !== undefined;
        if (started) { resolveStart(); } else { proc.once("spawn", () => { started = true; resolveStart(); }); }
        // kill等の操作でもerrorが届くため、起動後や終了処理中も継続して捕捉する。
        proc.on("error", error => {
            if (started) {
                // 操作失敗だけでは終了を断定しない。退役した子の通知も現在の配信へ作用させない。
                const code = (error as NodeJS.ErrnoException).code;
                log.error("TSDecoder#%d process operation failed (command=%s, pid=%d, code=%s, closed=%s)",
                    this._id, this._command, proc.pid, typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "unknown", this._closed);
                return;
            }
            failStart(error);
        });

        proc.once("close", (code, signal) => {
            log.info(
                "TSDecoder#%d process has closed with exit code=%d by signal `%s` (pid=%d)",
                this._id, code, signal, proc.pid
            );
            // error側で処理済みの失敗や、退役した子のcloseで再試行を二重に進めない。
            if (!failedToStart && this._process === proc) { this._dead(); }
        });

        // stdin may fail before the child close event (for example EPIPE).
        const onError = (err: Error) => {
            if (this._process === proc) {
                log.error("TSDecoder#%d process error: %s", this._id, err.message);
                this._dead();
            }
        };
        proc.stdin.on("error", onError);

        proc.stderr.pipe(process.stderr);
        let firstOutput = true;
        this._handleData = (chunk: Buffer) => {
            if (this._closed || this._process !== proc || this._output.writableEnded || this._output.destroyed) { return; }
            if (firstOutput) { firstOutput = false; clearTimeout(this._timeout); }
            // 上流のfilterが公開writableLength/HWMを見て入力を抑える既存方式を使う。
            // stdout自体はpauseせず、受信済みの復号出力を渡す。この出力queueには独立した保持量制限を設けない。
            this._output.write(chunk);
        };
        proc.stdout.on("data", this._handleData);

        this._readable = proc.stdout;
        this._writable = proc.stdin;
        this._notifyDrain();

        this._isNew = true;

        log.info("TSDecoder#%d process has spawned by command `%s` (pid=%d)", this._id, this._command, proc.pid);
    }

    private _dead(logExit = true): void {
        if (this._closed || this._respawnTimeout !== undefined) {
            return;
        }

        if (logExit) { log.error("TSDecoder#%d unexpected dead", this._id); }

        // 正常な受信を挟んでも、この配信全体の失敗回数（タイムアウトの重み付けを含む）を保持する。
        // 素通しできないTLV変換を無期限に起動し直さず、再試行上限で呼出元へ終了を返す。
        ++this._deadCount;
        clearTimeout(this._timeout);
        // 終了要求中を除き、素通しへの切替先を用意するまで入力待ちを解放しない。
        const fallback = this._deadCount > 3 && this._passThroughOnFailure && !this.writableEnded;
        this._kill(!fallback);
        // 待機callbackの解放で_finalが終了処理へ進んだ場合は、再起動やfallbackを作らない。
        if (this._closed) { return; }

        if (this._deadCount > 3) {
            if (this._passThroughOnFailure) {
                this._fallback();
                this._releaseInput?.();
            } else {
                log.error("TSDecoder#%d gave up, closing the stream (command=%s)", this._id, this._command);
                this._close();
            }
            return;
        }

        this._respawnTimeout = setTimeout(() => {
            this._respawnTimeout = undefined;
            this._spawn();
        }, 1500);
    }

    private _fallback(): void {
        const passThrough = new stream.PassThrough({ allowHalfOpen: false });

        this._handleData = (chunk: Buffer) => {
            if (this._closed || this._readable !== passThrough || this._output.writableEnded || this._output.destroyed) { return; }
            this._output.write(chunk);
        };
        passThrough.on("data", this._handleData);

        this._readable = passThrough;
        this._writable = passThrough;
        this._notifyDrain();
        this._startup = Promise.resolve();

        log.warn("TSDecoder#%d has been fallback into pass-through stream", this._id);
    }

    private _kill(releaseInput = true): void {
        // stdinのerrorはstdoutの残りより先に届く。出力をendする前に、この子の転送だけを外す。
        if (this._readable && this._handleData) {
            this._readable.removeListener("data", this._handleData);
            this._handleData = undefined;
        }
        if (this._process) {
            const proc = this._process;
            delete this._process;
            proc.kill("SIGKILL");
        }

        if (this._readable) {
            this._readable.destroy();
            delete this._readable;
        }

        if (this._writable) {
            const writable = this._writable;
            this._writable = undefined;
            writable.destroy();
        }
        // callbackは次の_writeを同期的に進め得るため、退役したstdinを先に外す。
        if (releaseInput) { this._releaseInput?.(); }
    }

    private _close(endOutput = true): void {
        if (this._closed === true) {
            return;
        }
        this._closed = true;

        if (this._endTimeout !== undefined) { clearTimeout(this._endTimeout); this._endTimeout = undefined; }

        clearTimeout(this._timeout);
        if (this._respawnTimeout !== undefined) { clearTimeout(this._respawnTimeout); this._respawnTimeout = undefined; }
        this._kill();

        if (endOutput && this._output.writableEnded === false) {
            this._output.end();
        }
        // 出力先の所有者が登録した保存・解放処理を残し、自分の購読だけを解除する。
        this._output.removeListener("finish", this._handleOutputClose);
        this._output.removeListener("close", this._handleOutputClose);
        this._output.removeListener("drain", this._handleOutputDrain);
        this.removeListener("drain", this._handleInputDrain);
        this._drainPending = false;

        --status.streamCount.decoder;

        log.info("TSDecoder#%d has closed (command=%s)", this._id, this._command);

        // close
        this.emit("close");
        this.emit("end");
    }
}
