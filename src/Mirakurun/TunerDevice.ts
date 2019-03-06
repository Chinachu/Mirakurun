/*
   Copyright 2016 Yuki KAN

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
import * as events from "events";
import * as child_process from "child_process";
import * as stream from "stream";
import * as fs from "fs";
import * as util from "util";
import * as common from "./common";
import * as log from "./log";
import * as config from "./config";
import * as apid from "../../api";
import status from "./status";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import Client, { ProgramsQuery } from "../client";

interface User extends common.User {
    _stream?: stream.Duplex;
}

interface Status {
    readonly index: number;
    readonly name: string;
    readonly types: common.ChannelType[];
    readonly command: string;
    readonly pid: number;
    readonly users: common.User[];
    readonly isAvailable: boolean;
    readonly isRemote: boolean;
    readonly isFree: boolean;
    readonly isUsing: boolean;
    readonly isFault: boolean;
}

export default class TunerDevice extends events.EventEmitter {

    private _channel: ChannelItem = null;
    private _command: string = null;
    private _process: child_process.ChildProcess = null;
    private _stream: stream.Readable = null;

    private _users: User[] = [];

    private _isAvailable: boolean = true;
    private _isRemote: boolean = false;
    private _isFault: boolean = false;
    private _fatalCount: number = 0;
    private _exited: boolean = false;
    private _closing: boolean = false;

    constructor(private _index: number, private _config: config.Tuner) {
        super();
        this._isRemote = !!this._config.remoteMirakurunHost;
        Event.emit("tuner", "create", this.export());
        log.debug("TunerDevice#%d initialized", this._index);
    }

    get index(): number {
        return this._index;
    }

    get config(): config.Tuner {
        return this._config;
    }

    get channel(): ChannelItem {
        return this._channel;
    }

    get command(): string {
        return this._command;
    }

    get pid(): number {
        return this._process ? this._process.pid : null;
    }

    get users(): User[] {
        return this._users.map(user => {
            return {
                id: user.id,
                priority: user.priority,
                agent: user.agent
            };
        });
    }

    get decoder(): string {
        return this._config.decoder || null;
    }

    get isAvailable(): boolean {
        return this._isAvailable;
    }

    get isRemote(): boolean {
        return this._isRemote;
    }

    get isFree(): boolean {
        return this._isAvailable === true && this._channel === null && this._users.length === 0;
    }

    get isUsing(): boolean {
        return this._isAvailable === true && this._channel !== null && this._users.length !== 0;
    }

    get isFault(): boolean {
        return this._isFault;
    }

    getPriority(): number {

        let priority = -2;

        for (const user of this._users) {
            if (user.priority > priority) {
                priority = user.priority;
            }
        }

        return priority;
    }

    export(): Status {
        return {
            index: this._index,
            name: this._config.name,
            types: this._config.types,
            command: this._command,
            pid: this.pid,
            users: this.users,
            isAvailable: this.isAvailable,
            isRemote: this.isRemote,
            isFree: this.isFree,
            isUsing: this.isUsing,
            isFault: this.isFault
        };
    }

    async kill(): Promise<void> {
        await this._kill(true);
    }

    async startStream(user: User, stream: stream.Duplex, channel?: ChannelItem): Promise<void> {

        log.debug("TunerDevice#%d start stream for user `%s` (priority=%d)...", this._index, user.id, user.priority);

        if (this._isAvailable === false) {
            throw new Error(util.format("TunerDevice#%d is not available", this._index));
        }

        if (!channel && !this._stream) {
            throw new Error(util.format("TunerDevice#%d has not stream", this._index));
        }

        if (channel) {
            if (this._config.types.indexOf(channel.type) === -1) {
                throw new Error(util.format("TunerDevice#%d is not supported for channel type `%s`", this._index, channel.type));
            }

            if (this._stream) {
                if (channel.channel !== this._channel.channel) {
                    if (user.priority <= this.getPriority()) {
                        throw new Error(util.format("TunerDevice#%d has higher priority user", this._index));
                    }

                    await this._kill(true);
                    await this._spawn(channel);
                }
            } else {
                await this._spawn(channel);
            }
        }

        log.info("TunerDevice#%d streaming to user `%s` (priority=%d)", this._index, user.id, user.priority);

        user._stream = stream;
        this._users.push(user);
        stream.once("close", () => this.endStream(user));

        this._updated();
    }

    endStream(user: User): void {

        log.debug("TunerDevice#%d end stream for user `%s` (priority=%d)...", this._index, user.id, user.priority);

        {
            const l = this._users.length;
            for (let i = 0; i < l; i++) {
                if (this._users[i].id === user.id && this._users[i].priority === user.priority) {
                    this._users[i]._stream.end();
                    this._users.splice(i, 1);
                    break;
                }
            }
        }

        if (this._users.length === 0) {
            setTimeout(() => {
                if (this._users.length === 0 && this._process) {
                    this._kill(true).catch(log.error);
                }
            }, 3000);
        }

        log.info("TunerDevice#%d end streaming to user `%s` (priority=%d)", this._index, user.id, user.priority);

        this._updated();
    }

    async getRemotePrograms(query?: ProgramsQuery): Promise<apid.Program[]> {

        if (!this._isRemote) {
            throw new Error(util.format("TunerDevice#%d is not remote device", this._index));
        }

        log.debug(
            "TunerDevice#%d fetching remote programs from %s:%d...",
            this._index, this.config.remoteMirakurunHost, this.config.remoteMirakurunPort
        );

        const client = new Client();
        client.host = this.config.remoteMirakurunHost;
        client.port = this.config.remoteMirakurunPort;
        client.userAgent = "Mirakurun (Remote)";

        const programs = await client.getPrograms(query);

        log.info("TunerDevice#%d fetched %d remote programs", this._index, programs.length);

        return programs;
    }

    private async _spawn(ch: ChannelItem): Promise<void> {

        log.debug("TunerDevice#%d spawn...", this._index);

        if (this._process) {
            throw new Error(util.format("TunerDevice#%d has process", this._index));
        }

        let cmd: string;

        if (this._isRemote === true) {
            cmd = "node lib/remote";
            cmd += " " + this._config.remoteMirakurunHost;
            cmd += " " + (this._config.remoteMirakurunPort || 40772);
            cmd += " " + ch.type;
            cmd += " " + ch.channel;
            if (this._config.remoteMirakurunDecoder === true) {
                cmd += " decode";
            }
        } else {
            cmd = this._config.command;
        }

        cmd = cmd.replace("<channel>", ch.channel);

        if (ch.satelite) {
            cmd = cmd.replace("<satelite>", ch.satelite);
        }

        if (ch.space) {
            cmd = cmd.replace("<space>", ch.space.toString(10));
        } else {
            cmd = cmd.replace("<space>", "0"); // set default value to '0'
        }

        this._process = child_process.spawn(cmd.split(" ")[0], cmd.split(" ").slice(1));
        this._command = cmd;
        this._channel = ch;

        if (this._config.dvbDevicePath) {
            const cat = child_process.spawn("cat", [this._config.dvbDevicePath]);

            cat.once("error", (err) => {

                log.error("TunerDevice#%d cat process error `%s` (pid=%d)", this._index, err.name, cat.pid);

                this._kill(false);
            });

            cat.once("close", (code, signal) => {

                log.debug(
                    "TunerDevice#%d cat process has closed with code=%d by signal `%s` (pid=%d)",
                    this._index, code, signal, cat.pid
                );

                if (this._exited === false) {
                    this._kill(false);
                }
            });

            this._process.once("exit", () => cat.kill("SIGKILL"));

            this._stream = cat.stdout;
        } else {
            this._stream = this._process.stdout;
        }

        this._process.once("exit", () => this._exited = true);

        this._process.once("error", (err) => {

            log.fatal("TunerDevice#%d process error `%s` (pid=%d)", this._index, err.name, this._process.pid);

            ++this._fatalCount;
            if (this._fatalCount >= 3) {
                log.fatal("TunerDevice#%d has something fault! **RESTART REQUIRED** after fix it.", this._index);

                this._isFault = true;
                this._closing = true;
            }
            this._end();
            setTimeout(this._release.bind(this), this._config.dvbDevicePath ? 1000 : 100);
        });

        this._process.once("close", (code, signal) => {

            log.info(
                "TunerDevice#%d process has closed with exit code=%d by signal `%s` (pid=%d)",
                this._index, code, signal, this._process.pid
            );

            this._end();
            setTimeout(this._release.bind(this), this._config.dvbDevicePath ? 1000 : 100);
        });

        this._process.stderr.on("data", data => {
            log.info("TunerDevice#%d > %s", this._index, data.toString().trim());
        });

        // flowing start
        this._stream.on("data", this._streamOnData.bind(this));

        this._updated();
        log.info("TunerDevice#%d process has spawned by command `%s` (pid=%d)", this._index, cmd, this._process.pid);
    }

    private _streamOnData(chunk: Buffer): void {

        for (let i = 0; i < this._users.length; i++) {
            this._users[i]._stream.write(chunk);
        }
    }

    private _end(): void {

        this._isAvailable = false;

        this._stream.removeAllListeners("data");

        if (this._closing === true) {
            for (const user of this._users) {
                user._stream.end();
            }
            this._users = [];
        }

        this._updated();
    }

    private async _kill(close: boolean): Promise<void> {

        log.debug("TunerDevice#%d kill...", this._index);

        if (!this._process || !this._process.pid) {
            throw new Error(util.format("TunerDevice#%d has not process", this._index));
        } else if (this._closing) {
            log.debug("TunerDevice#%d return because it is closing", this._index);
            return;
        }

        this._isAvailable = false;
        this._closing = close;

        this._updated();

        await new Promise<void>(resolve => {

            this.once("release", resolve);

            if (process.platform === "win32") {
                const timer = setTimeout(() => this._process.kill(), 3000);
                this._process.once("exit", () => clearTimeout(timer));

                this._process.stdin.write("\n");
            } else {
                const timer = setTimeout(() => {
                    log.warn("TunerDevice#%d will force killed because SIGTERM timed out...", this._index);
                    this._process.kill("SIGKILL");
                }, 6000);
                this._process.once("exit", () => clearTimeout(timer));

                // regular way
                this._process.kill("SIGTERM");
            }
        });
    }

    private _release(): void {

        if (this._process) {
            this._process.stderr.removeAllListeners();
            this._process.removeAllListeners();
        }
        if (this._stream) {
            this._stream.removeAllListeners();
        }

        this._command = null;
        this._process = null;
        this._stream = null;

        if (this._closing === true) {
            this._channel = null;
            this._users = [];
        }

        if (this._isFault === false) {
            this._isAvailable = true;
        }

        this._closing = false;
        this._exited = false;

        this.emit("release");

        log.debug("TunerDevice#%d released", this._index);

        this._updated();

        if (this._closing === false && this._users.length !== 0) {
            log.debug("TunerDevice#%d respawning because request has not closed", this._index);
            ++status.errorCount.tunerDeviceRespawn;

            this._spawn(this._channel);
        } else {
            this._fatalCount = 0;
        }
    }

    private _updated(): void {
        Event.emit("tuner", "update", this.export());
    }
}
