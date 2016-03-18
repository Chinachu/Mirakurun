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
import _ = require('./_');
import common = require('./common');
import log = require('./log');
import config = require('./config');
import TunerDevice = require('./TunerDevice');
import ChannelItem = require('./ChannelItem');
import ServiceItem = require('./ServiceItem');
import ProgramItem = require('./ProgramItem');
import TSFilter = require('./TSFilter');

interface StreamSetting {
    channel: ChannelItem;
    serviceId?: number;
    eventId?: number;
}

class Tuner {

    private _devices: TunerDevice[] = [];

    constructor() {

        this._load();

        _.tuner = this;
    }

    typeExists(type: string): boolean {

        let i, l = this._devices.length;
        for (i = 0; i < l; i++) {
            if (this._devices[i].config.types.indexOf(type) !== -1) {
                return true;
            }
        }

        return false;
    }

    getChannelStream(channel: ChannelItem, user: common.User): Promise<stream.Readable> {

        const setting: StreamSetting = {
            channel: channel
        };

        return this._getStream(setting, user);
    }

    getServiceStream(service: ServiceItem, user: common.User): Promise<stream.Readable> {

        const setting: StreamSetting = {
            channel: service.channel,
            serviceId: service.id
        };

        return this._getStream(setting, user);
    }

    getProgramStream(program: ProgramItem, user: common.User): Promise<stream.Readable> {

        const setting: StreamSetting = {
            channel: program.service.channel,
            serviceId: program.data.serviceId,
            eventId: program.data.eventId
        };

        return this._getStream(setting, user);
    }

    private _load(): this {

        log.debug('loading tuners...');

        const tuners = config.loadTuners();

        tuners.forEach((tuner, i) => {

            if (!tuner.name || !tuner.types || !tuner.command) {
                log.error('missing required property in tuner#%s configuration', i);
                return;
            }

            if (typeof tuner.name !== 'string') {
                log.error('invalid type of property `name` in tuner#%s configuration', i);
                return;
            }

            if (Array.isArray(tuner.types) === false) {
                console.log(tuner);
                log.error('invalid type of property `types` in tuner#%s configuration', i);
                return;
            }

            if (typeof tuner.command !== 'string') {
                log.error('invalid type of property `command` in tuner#%s configuration', i);
                return;
            }

            if (tuner.dvbDevicePath && typeof tuner.dvbDevicePath !== 'string') {
                log.error('invalid type of property `dvbDevicePath` in tuner#%s configuration', i);
                return;
            }

            if (tuner.isDisabled) {
                return;
            }

            this._devices.push(
                new TunerDevice(i, tuner)
            );
        });

        log.info('%s of %s tuners loaded', this._devices.length, tuners.length);

        return this;
    }

    private _getStream(setting: StreamSetting, user: common.User): Promise<stream.Readable> {

        return new Promise<stream.Readable>((resolve, reject) => {

            const devices = this._getDevicesByType(setting.channel.type);

            let tryCount = 20;
            let i, l = devices.length;

            function find() {

                let device: TunerDevice = null;

                // 1.
                for (i = 0; i < l; i++) {
                    if (devices[i].isAvailable === false) {
                        continue;
                    }
                    if (devices[i].channel === setting.channel) {
                        device = devices[i];
                        break;
                    }
                }

                // 2.
                if (device === null) {
                    for (i = 0; i < l; i++) {
                        if (devices[i].isFree === true) {
                            device = devices[i];
                            break;
                        }
                    }
                }

                // 3.
                if (device === null) {
                    for (i = 0; i < l; i++) {
                        if (devices[i].isUsing === true && devices[i].getPriority() < user.priority) {
                            device = devices[i];
                            break;
                        }
                    }
                }

                if (device === null) {
                    --tryCount;
                    if (tryCount > 0) {
                        setTimeout(find, 250);
                    } else {
                        reject(new Error('no available tuners'));
                    }
                } else {
                    const tsFilter = new TSFilter({
                        serviceId: setting.serviceId,
                        eventId: setting.eventId
                    });

                    device.startStream(user, tsFilter, setting.channel)
                        .then(() => {
                            if (user.disableDecoder === true || device.decoder === null) {
                                resolve(tsFilter);
                            } else {
                                const decoder = child_process.spawn(device.decoder);
                                decoder.stdout.once('close', () => tsFilter.emit('close'));
                                tsFilter.once('close', () => decoder.kill('SIGKILL'));
                                tsFilter.pipe(decoder.stdin);
                                resolve(decoder.stdout);
                            }
                        })
                        .catch((err) => {
                            //tsFilter.end();
                            tsFilter.emit('close');
                            reject(err);

                            //return Promise.reject(err);
                        });
                }
            }
            find();
        });
    }

    private _getDevicesByType(type: string): TunerDevice[] {

        const devices = [];

        let i, l = this._devices.length;
        for (i = 0; i < l; i++) {
            if (this._devices[i].config.types.indexOf(type) !== -1) {
                devices.push(this._devices[i]);
            }
        }

        return devices;
    }

    static typeExists(type: string): boolean {
        return _.tuner.typeExists(type);
    }

    static getChannelStream(channel: ChannelItem, user: common.User): Promise<stream.Readable> {
        return _.tuner.getChannelStream(channel, user);
    }

    static getServiceStream(service: ServiceItem, user: common.User): Promise<stream.Readable> {
        return _.tuner.getServiceStream(service, user);
    }

    static getProgramStream(program: ProgramItem, user: common.User): Promise<stream.Readable> {
        return _.tuner.getProgramStream(program, user);
    }
}

export = Tuner;