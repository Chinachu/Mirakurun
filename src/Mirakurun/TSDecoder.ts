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

    private _isNew: boolean = false;
    private _timeout: NodeJS.Timeout;
    private _closed: boolean = false;
    private _deadCount: number = 0;

    constructor(opts: StreamOptions) {
        super();

        this._id = idCounter++;
        this._command = opts.command;
        this._withArgs = opts.withArgs === true;
        this._startupTimeout = opts.startupTimeout || 1500;
        this._passThroughOnFailure = opts.passThroughOnFailure !== false;

        this._output = opts.output;
        this._output.once("finish", this._close.bind(this));
        this._output.once("close", this._close.bind(this));

        Object.defineProperty(this, "writableLength", {
            get() { return opts.output.writableLength; }
        });
        Object.defineProperty(this, "writableHighWaterMark", {
            get() { return opts.output.writableHighWaterMark; }
        });

        this.once("close", this._close.bind(this));

        log.info("TSDecoder#%d has created (command=%s)", this._id, this._command);

        ++status.streamCount.decoder;

        this._spawn();
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
                // counted as 2 failures as before (the process killed was also counted when it closed),
                // falls back (or closes the stream) after 2 timeouts
                ++this._deadCount;
                this._dead();
            }, this._startupTimeout);
        }

        this._writable.write(chunk);
        callback();
    }

    /** cork() してまとめて書き込まれた出力を、1 回でデコーダーに渡す */
    _writev(chunks: { chunk: Buffer }[], callback: Function) {
        if (!this._writable) {
            callback();
            return;
        }

        this._writable.cork();
        for (const { chunk } of chunks) {
            this._write(chunk, null, () => { /* 最後にまとめて呼ぶ */ });
        }
        this._writable.uncork();
        callback();
    }

    _final() {
        this._close();
    }

    private _spawn(): void {
        if (this._closed === true || this._process) {
            return;
        }
        if (this._deadCount > 0) {
            ++status.errorCount.decoderRespawn;
            log.warn("TSDecoder#%d respawning because dead (count=%d)", this._id, this._deadCount);
        }

        let proc: child_process.ChildProcess;
        if (this._withArgs) {
            const parsed = parseCommandForSpawn(this._command);
            proc = this._process = child_process.spawn(parsed.command, parsed.args);
        } else {
            proc = this._process = child_process.spawn(this._command);
        }

        proc.once("close", (code, signal) => {
            log.info(
                "TSDecoder#%d process has closed with exit code=%d by signal `%s` (pid=%d)",
                this._id, code, signal, proc.pid
            );
            if (this._process === proc) {
                this._dead();
            }
        });

        // stdin may fail before the child close event (for example EPIPE).
        const onError = (err: Error) => {
            if (this._process === proc) {
                log.error("TSDecoder#%d process error: %s", this._id, err.message);
                this._dead();
            }
        };
        proc.once("error", onError);
        proc.stdin.on("error", onError);

        proc.stderr.pipe(process.stderr);
        proc.stdout.once("data", () => clearTimeout(this._timeout));
        proc.stdout.on("data", chunk => this._output.write(chunk));

        this._readable = proc.stdout;
        this._writable = proc.stdin;

        this._isNew = true;

        log.info("TSDecoder#%d process has spawned by command `%s` (pid=%d)", this._id, this._command, proc.pid);
    }

    private _dead(): void {
        if (this._closed === true) {
            return;
        }

        log.error("TSDecoder#%d unexpected dead", this._id);

        ++this._deadCount;
        clearTimeout(this._timeout);
        this._kill();

        if (this._deadCount > 3) {
            if (this._passThroughOnFailure) {
                this._fallback();
            } else {
                log.error("TSDecoder#%d gave up, closing the stream (command=%s)", this._id, this._command);
                this._close();
            }
            return;
        }

        setTimeout(() => this._spawn(), 1500);
    }

    private _fallback(): void {
        const passThrough = new stream.PassThrough({ allowHalfOpen: false });

        passThrough.on("data", chunk => this._output.write(chunk));

        this._readable = passThrough;
        this._writable = passThrough;

        log.warn("TSDecoder#%d has been fallback into pass-through stream", this._id);
    }

    private _kill(): void {
        if (this._process) {
            this._process.kill("SIGKILL");
            delete this._process;
        }

        if (this._readable) {
            this._readable.destroy();
            delete this._readable;
        }

        if (this._writable) {
            this._writable.destroy();
            delete this._writable;
        }
    }

    private _close(): void {
        if (this._closed === true) {
            return;
        }
        this._closed = true;

        clearTimeout(this._timeout);
        this._kill();

        if (this._output.writableEnded === false) {
            this._output.end();
        }
        this._output.removeAllListeners();
        delete this._output;

        --status.streamCount.decoder;

        log.info("TSDecoder#%d has closed (command=%s)", this._id, this._command);

        // close
        this.emit("close");
        this.emit("end");
    }
}
