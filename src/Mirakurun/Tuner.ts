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
/// <reference path="../../typings/index.d.ts" />
"use strict";

import * as child_process from "child_process";
import * as stream from "stream";
import * as common from "./common";
import * as log from "./log";
import _ from "./_";
import db from "./db";
import TunerDevice from "./TunerDevice";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";
import ProgramItem from "./ProgramItem";
import TSFilter from "./TSFilter";

interface StreamSetting {
    channel: ChannelItem;
    networkId?: number;
    serviceId?: number;
    eventId?: number;
    noProvide?: boolean;
    parseSDT?: boolean;
    parseEIT?: boolean;
}

export default class Tuner {

    private _devices: TunerDevice[] = [];

    constructor() {

        this._load();

        _.tuner = this;
    }

    get devices(): TunerDevice[] {
        return this._devices;
    }

    get(index: number): TunerDevice {

        for (let i = 0, l = this._devices.length; i < l; i++) {
            if (this._devices[i].index === index) {
                return this._devices[i];
            }
        }

        return null;
    }

    typeExists(type: common.ChannelType): boolean {

        for (let i = 0, l = this._devices.length; i < l; i++) {
            if (this._devices[i].config.types.indexOf(type) !== -1) {
                return true;
            }
        }

        return false;
    }

    getChannelStream(channel: ChannelItem, user: common.User): Promise<stream.Readable> {

        let networkId;

        const services = channel.getServices();
        if (services.length !== 0) {
            networkId = services[0].networkId;
        }

        const setting: StreamSetting = {
            channel: channel,
            networkId: networkId,
            parseEIT: true
        };

        return this._getStream(setting, user);
    }

    getServiceStream(service: ServiceItem, user: common.User): Promise<stream.Readable> {

        const setting: StreamSetting = {
            channel: service.channel,
            serviceId: service.serviceId,
            networkId: service.networkId,
            parseEIT: true
        };

        return this._getStream(setting, user);
    }

    getProgramStream(program: ProgramItem, user: common.User): Promise<stream.Readable> {

        const setting: StreamSetting = {
            channel: program.service.channel,
            serviceId: program.data.serviceId,
            eventId: program.data.eventId,
            networkId: program.data.networkId,
            parseEIT: true
        };

        return this._getStream(setting, user);
    }

    getEPG(channel: ChannelItem, time?: number): Promise<void> {

        if (!time) {
            time = _.config.server.epgRetrievalTime || 1000 * 60 * 10;
        }

        let networkId;

        const services = channel.getServices();
        if (services.length !== 0) {
            networkId = services[0].networkId;
        }

        const setting: StreamSetting = {
            channel: channel,
            networkId: networkId,
            noProvide: true,
            parseEIT: true
        };

        const user: common.User = {
            id: "Mirakurun:getEPG()",
            priority: -1,
            disableDecoder: true
        };

        return this._getStream(setting, user)
            .then(stream => {
                return new Promise<void>((resolve) => {
                    setTimeout(() => stream.emit("close"), time);
                    stream.once("epgReady", () => stream.emit("close"));
                    stream.once("close", resolve);
                });
            })
            .catch(error => {
                return Promise.reject(error);
            });
    }

    getServices(channel: ChannelItem): Promise<db.Service[]> {

        const setting: StreamSetting = {
            channel: channel,
            noProvide: true,
            parseSDT: true
        };

        const user: common.User = {
            id: "Mirakurun:getServices()",
            priority: -1,
            disableDecoder: true
        };

        return this._getStream(setting, user)
            .then(stream => {
                return new Promise((resolve, reject) => {

                    let services: db.Service[] = null;

                    setTimeout(() => stream.emit("close"), 10000);

                    stream.once("services", _services => {
                        services = _services;
                        stream.emit("close");
                    });

                    stream.once("close", () => {

                        stream.removeAllListeners("services");

                        if (services === null) {
                            reject(new Error("stream has closed before get services"));
                        } else {
                            resolve(services);
                        }
                    });
                });
            })
            .catch(error => {
                return Promise.reject(error);
            });
    }

    private _load(): this {

        log.debug("loading tuners...");

        const tuners = _.config.tuners;

        tuners.forEach((tuner, i) => {

            if (!tuner.name || !tuner.types || !tuner.command) {
                log.error("missing required property in tuner#%s configuration", i);
                return;
            }

            if (typeof tuner.name !== "string") {
                log.error("invalid type of property `name` in tuner#%s configuration", i);
                return;
            }

            if (Array.isArray(tuner.types) === false) {
                console.log(tuner);
                log.error("invalid type of property `types` in tuner#%s configuration", i);
                return;
            }

            if (typeof tuner.command !== "string") {
                log.error("invalid type of property `command` in tuner#%s configuration", i);
                return;
            }

            if (tuner.dvbDevicePath && typeof tuner.dvbDevicePath !== "string") {
                log.error("invalid type of property `dvbDevicePath` in tuner#%s configuration", i);
                return;
            }

            if (tuner.isDisabled) {
                return;
            }

            this._devices.push(
                new TunerDevice(i, tuner)
            );
        });

        log.info("%s of %s tuners loaded", this._devices.length, tuners.length);

        return this;
    }

    private _getStream(setting: StreamSetting, user: common.User): Promise<stream.Readable> {

        return new Promise<stream.Readable>((resolve, reject) => {

            const devices = this._getDevicesByType(setting.channel.type);

            let tryCount = 20;
            const length = devices.length;

            function find() {

                let device: TunerDevice = null;

                // 1. join to existing
                for (let i = 0; i < length; i++) {
                    if (devices[i].isAvailable === true && devices[i].channel === setting.channel) {
                        device = devices[i];
                        break;
                    }
                }

                // 2. start as new
                if (device === null) {
                    for (let i = 0; i < length; i++) {
                        if (devices[i].isFree === true) {
                            device = devices[i];
                            break;
                        }
                    }
                }

                // 3. replace existing
                if (device === null) {
                    for (let i = 0; i < length; i++) {
                        if (devices[i].isAvailable === true && devices[i].users.length === 0) {
                            device = devices[i];
                            break;
                        }
                    }
                }

                // 4. takeover existing
                if (device === null) {
                    for (let i = 0; i < length; i++) {
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
                        reject(new Error("no available tuners"));
                    }
                } else {
                    const tsFilter = new TSFilter({
                        networkId: setting.networkId,
                        serviceId: setting.serviceId,
                        eventId: setting.eventId,
                        noProvide: setting.noProvide,
                        parseSDT: setting.parseSDT,
                        parseEIT: setting.parseEIT
                    });

                    device.startStream(user, tsFilter, setting.channel)
                        .then(() => {
                            if (user.disableDecoder === true || device.decoder === null) {
                                resolve(tsFilter);
                            } else {
                                const decoder = child_process.spawn(device.decoder);
                                decoder.stderr.pipe(process.stderr);
                                decoder.stdout.once("close", () => tsFilter.emit("close"));
                                tsFilter.once("close", () => decoder.kill("SIGKILL"));
                                tsFilter.pipe(decoder.stdin);
                                resolve(decoder.stdout);
                            }
                        })
                        .catch((err) => {
                            tsFilter.emit("close");
                            reject(err);
                        });
                }
            }
            find();
        });
    }

    private _getDevicesByType(type: common.ChannelType): TunerDevice[] {

        const devices = [];

        for (let i = 0, l = this._devices.length; i < l; i++) {
            if (this._devices[i].config.types.indexOf(type) !== -1) {
                devices.push(this._devices[i]);
            }
        }

        return devices;
    }

    static all(): TunerDevice[] {
        return _.tuner.devices;
    }

    static get(index: number): TunerDevice {
        return _.tuner.get(index);
    }

    static typeExists(type: common.ChannelType): boolean {
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

    static getEPG(channel: ChannelItem, time?: number): Promise<void> {
        return _.tuner.getEPG(channel, time);
    }

    static getServices(channel: ChannelItem): Promise<db.Service[]> {
        return _.tuner.getServices(channel);
    }
}