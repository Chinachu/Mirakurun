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

import events = require('events');
import child_process = require('child_process');
import stream = require('stream');
import fs = require('fs');
import log = require('./log');
import config = require('./config');

interface User {
    id: string;
    priority: number;
    agent?: string;

    _stream?: stream.Writable;
}

interface Channel {
    type: string;
    channel: string;
    satelite?: string;
}

class TunerDevice extends events.EventEmitter {

    private _channel: Channel;
    private _command: string;
    private _process: child_process.ChildProcess;
    private _stream: stream.Readable;
    private _users: User[];
    private _isAvailable: boolean;

    constructor(private _index: number, private _config: config.Tuner) {
        super();

        this.release();
    }

    get index(): number {
        return this._index;
    }

    get config(): config.Tuner {
        return this._config;
    }

    get channel(): Channel {
        return this._channel;
    }

    get command(): string {
        return this._command;
    }

    get pid(): number {
        return this._process ? this._process.pid : null;
    }

    get users(): User[] {
        return this._users;
    }

    get isAvailable(): boolean {
        return this._isAvailable;
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

    startStream(user: User, stream: stream.Writable, channel?: Channel): Promise<void> {

        if (this._isAvailable === false) {
            return Promise.reject(new Error('TunerDevice#' + this._index + ' is not available'));
        }

        const resolve = () => {
            user._stream = stream;
            this._users.push(user);
            return Promise.resolve();
        };

        if (!channel) {
            if (!this._stream) {
                return Promise.reject(new Error('TunerDevice#' + this._index + ' has not stream'));
            } else {
                return resolve();
            }
        }

        if (this._config.types.indexOf(channel.type) === -1) {
            return Promise.reject(
                new Error('TunerDevice#' + this._index + ' is not supported for channel type `' + channel.type + '`')
            );
        }

        if (this._stream) {
            if (channel.channel === this._channel.channel) {
                return resolve();
            } else if (user.priority <= this.getPriority()) {
                return Promise.reject(new Error('TunerDevice#' + this._index + ' has higher priority user'));
            }

            return this.kill()
                .then(() => this.spawn(channel))
                .catch(log.error)
                .then(resolve);
        } else {
            return this.spawn(channel).then(resolve);
        }
    }

    endStream(user: User): void {

        let i, l = this._users.length;
        for (i = 0; i < l; i++) {
            if (this._users[i].id === user.id && this._users[i].priority === user.priority) {
                this._users.splice(i, 1);

                if (this._users[i]._stream) {
                    this._users[i]._stream.end();
                }

                break;
            }
        }

        if (this._users.length === 0) {
            this.kill().catch(log.error);
        }
    }

    private spawn(ch): Promise<void> {

        log.debug('TunerDevice#' + this._index + ' spawn...');

        if (this._process) {
            return Promise.reject(new Error('TunerDevice#' + this._index + ' has process'));
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
                'TunerDevice#' + this._index + ' process has exited with exit code `' + code +
                '` by signal `' + signal + '` (pid=' + this._process.pid + ')'
            );
        });

        this._process.once('close', (code, signal) => {

            this.release();

            log.debug(
                'TunerDevice#' + this._index + ' process closed with exit code `' + code +
                '` by signal `' + signal + '` (pid=' + this._process.pid + ')'
            );
        });

        this._process.stderr.on('data', data => {
            log.info('TunerDevice#' + this._index + ' stderr `' + data + '`');
        });

        // flowing start
        this._stream.on('data', chunk => {

            let i, l = this._users.length;
            for (i = 0; i < l; i++) {
                if (this._users[i]._stream) {
                    this._users[i]._stream.write(chunk);
                }
            }
        });

        this._stream.once('end', chunk => {

            this._stream.removeAllListeners('data');

            let i, l = this._users.length;
            for (i = 0; i < l; i++) {
                if (this._users[i]._stream) {
                    this._users[i]._stream.end(chunk);
                }
            }
        });

        log.info(
            'TunerDevice#' + this._index + ' process has spawned by command `' + cmd +
            '` (pid=' + this._process.pid + ')'
        );

        return Promise.resolve();
    }

    private kill(): Promise<void> {

        log.debug('TunerDevice#' + this._index + ' kill...');

        if (!this._process) {
            return Promise.reject(new Error('TunerDevice#' + this._index + ' has not process'));
        }

        this._isAvailable = false;

        return new Promise<void>(resolve => {
            this._process.once('close', () => resolve());
            this._process.kill('SIGTERM');
        });
    }

    private release(): void {

        this._channel = null;
        this._command = null;
        this._process = null;
        this._stream = null;
        this._users = [];
        this._isAvailable = true;

        log.debug('TunerDevice#' + this._index + ' released');
    }
}

export = TunerDevice;