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
/// <reference path="../../typings/node/node.d.ts" />
'use strict';

import child_process = require('child_process');
import stream = require('stream');
import fs = require('fs');
import util = require('util');
import common = require('./common');
import log = require('./log');
import config = require('./config');
import ChannelItem = require('./ChannelItem');

interface User extends common.User {
    _stream?: stream.Writable;
}

class TunerDevice {

    private _channel: ChannelItem;
    private _command: string;
    private _process: child_process.ChildProcess;
    private _stream: stream.Readable;
    private _users: User[];
    private _isAvailable: boolean;

    constructor(private _index: number, private _config: config.Tuner) {
        this._release();
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

    get isFree(): boolean {
        return this._isAvailable === true && this._channel === null && this._users.length === 0;
    }

    get isUsing(): boolean {
        return this._isAvailable === true && this._channel !== null && this._users.length !== 0;
    }

    getPriority(): number {

        let ret = 0;

        let i, l = this._users.length;
        for (i = 0; i < l; i++) {
            if (this._users[i].priority > ret) {
                ret = this._users[i].priority;
            }
        }

        return ret;
    }

    startStream(user: User, stream: stream.Writable, channel?: ChannelItem): Promise<void> {

        log.debug('TunerDevice#%d start stream for user `%s` (priority=%d)...', this._index, user.id, user.priority);

        if (this._isAvailable === false) {
            return Promise.reject(new Error(util.format('TunerDevice#%d is not available', this._index)));
        }

        const resolve = () => {

            log.info('TunerDevice#%d streaming to user `%s` (priority=%d)', this._index, user.id, user.priority);

            user._stream = stream;
            this._users.push(user);

            stream.once('close', () => this._endStream(user));

            return Promise.resolve();
        };

        if (!channel) {
            if (!this._stream) {
                return Promise.reject(new Error(util.format('TunerDevice#%d has not stream', this._index)));
            } else {
                return resolve();
            }
        }

        if (this._config.types.indexOf(channel.type) === -1) {
            return Promise.reject(
                new Error(util.format('TunerDevice#%d is not supported for channel type `%s`', this._index, channel.type))
            );
        }

        if (this._stream) {
            if (channel.channel === this._channel.channel) {
                return resolve();
            } else if (user.priority <= this.getPriority()) {
                return Promise.reject(new Error(util.format('TunerDevice#%d has higher priority user', this._index)));
            }

            return this._kill()
                .then(() => this._spawn(channel))
                .catch(log.error)
                .then(resolve);
        } else {
            return this._spawn(channel).then(resolve);
        }
    }

    private _endStream(user: User): void {

        log.debug('TunerDevice#%d end stream for user `%s` (priority=%d)...', this._index, user.id, user.priority);

        let i, l = this._users.length;
        for (i = 0; i < l; i++) {
            if (this._users[i].id === user.id && this._users[i].priority === user.priority) {
                this._users.splice(i, 1);
                this._users[i]._stream.end();
                break;
            }
        }

        if (this._users.length === 0) {
            this._kill().catch(log.error);
        }

        log.info('TunerDevice#%d end streaming to user `%s` (priority=%d)', this._index, user.id, user.priority);
    }

    private _spawn(ch): Promise<void> {

        log.debug('TunerDevice#%d spawn...', this._index);

        if (this._process) {
            return Promise.reject(new Error(util.format('TunerDevice#%d has process', this._index)));
        }

        let cmd = this._config.command;

        cmd = cmd.replace('<channel>', ch.channel);

        if (ch.satelite) {
            cmd = cmd.replace('<satelite>', ch.satelite);
        }

        this._process = child_process.spawn(cmd.split(' ')[0], cmd.split(' ').slice(1));
        this._command = cmd;
        this._channel = ch;

        if (this._config.dvbDevicePath) {
            this._stream = fs.createReadStream(this._config.dvbDevicePath);
        } else {
            this._stream = this._process.stdout;
        }

        this._process.once('exit', (code, signal) => {

            this._stream.emit('end');

            log.info(
                'TunerDevice#%d process has exited with exit code=%d by signal `%s` (pid=%d)',
                this._index, code, signal, this._process.pid
            );
        });

        this._process.once('close', (code, signal) => {

            this._release();

            log.debug(
                'TunerDevice#%d process closed with exit code=%d by signal `%s` (pid=%d)',
                this._index, code, signal, this._process.pid
            );
        });

        this._process.stderr.on('data', data => {
            log.info('TunerDevice#%d stderr `%s`', this._index, data);
        });

        // flowing start
        this._stream.on('data', chunk => {

            let i, l = this._users.length;
            for (i = 0; i < l; i++) {
                this._users[i]._stream.write(chunk);
            }
        });

        this._stream.once('end', chunk => {

            this._stream.removeAllListeners('data');

            let i, l = this._users.length;
            for (i = 0; i < l; i++) {
                this._users[i]._stream.end(chunk);
            }
        });

        log.info('TunerDevice#%d process has spawned by command `%s` (pid=%d)', this._index, cmd, this._process.pid);

        return Promise.resolve();
    }

    private _kill(): Promise<void> {

        log.debug('TunerDevice#%d kill...', this._index);

        if (!this._process) {
            return Promise.reject(new Error(util.format('TunerDevice#%d has not process', this._index)));
        }

        this._isAvailable = false;

        return new Promise<void>(resolve => {
            this._process.once('close', () => resolve());
            this._process.kill('SIGTERM');
        });
    }

    private _release(): this {

        this._channel = null;
        this._command = null;
        this._process = null;
        this._stream = null;
        this._users = [];
        this._isAvailable = true;

        log.debug('TunerDevice#%d released', this._index);

        return this;
    }
}

export = TunerDevice;