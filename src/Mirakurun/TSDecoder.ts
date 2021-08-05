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
import status from "./status";

interface StreamOptions extends stream.TransformOptions {
    readonly command: string;
}

let idCounter = 0;

export default class TSDecoder extends stream.Transform {

    private _id: number;
    private _command: string;
    private _process: child_process.ChildProcess;
    private _readable: stream.Readable;
    private _writable: stream.Writable;

    private _isNew: boolean = false;
    private _timeout: NodeJS.Timeout;
    private _closed: boolean = false;
    private _deadCount: number = 0;

    constructor(opts: StreamOptions) {
        super({
            ...opts,
            allowHalfOpen: false
        });

        this._id = idCounter++;
        this._command = opts.command;

        this.once("close", this._close.bind(this));

        log.info("TSDecoder#%d has created (command=%s)", this._id, this._command);

        ++status.streamCount.decoder;

        this._spawn();
    }

    _transform(chunk: Buffer, encoding: string, callback: Function) {

        if (!this._writable) {
            callback();
            return;
        }

        if (this._isNew === true && this._process) {
            this._isNew = false;
            this._timeout = setTimeout(() => {
                log.warn("TSDecoder#%d process will force killed because no respond...", this._id);
                this._dead();
            }, 1500);
        }

        this._writable.write(chunk);
        callback();
    }

    private _spawn(): void {

        if (this._closed === true || this._process) {
            return;
        }
        if (this._deadCount > 0) {
            ++status.errorCount.decoderRespawn;
            log.warn("TSDecoder#%d respawning because dead (count=%d)", this._id, this._deadCount);
        }

        const proc = this._process = child_process.spawn(this._command);

        proc.once("close", (code, signal) => {
            log.info(
                "TSDecoder#%d process has closed with exit code=%d by signal `%s` (pid=%d)",
                this._id, code, signal, proc.pid
            );
            this._dead();
        });

        proc.stderr.pipe(process.stderr);
        proc.stdout.once("data", () => clearTimeout(this._timeout));
        proc.stdout.on("data", chunk => this.push(chunk));

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
        this._kill();

        if (this._deadCount > 3) {
            this._fallback();
            return;
        }

        setTimeout(() => this._spawn(), 1500);
    }

    private _fallback(): void {

        const passThrough = new stream.PassThrough({ allowHalfOpen: false });

        passThrough.on("data", chunk => this.push(chunk));

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

        this._kill();

        --status.streamCount.decoder;

        log.info("TSDecoder#%d has closed (command=%s)", this._id, this._command);

        // close
        this.emit("close");
        this.emit("end");
    }
}
