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
import * as child_process from "child_process";
import * as stream from "stream";
import * as common from "./common";
import * as log from "./log";
import * as db from "./db";
import _ from "./_";
import status from "./status";
import TunerDevice from "./TunerDevice";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";
import ProgramItem from "./ProgramItem";
import TSFilter from "./TSFilter";

export default class Tuner {

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

    private _devices: TunerDevice[] = [];

    constructor() {

        this._load();
    }

    get devices(): TunerDevice[] {
        return this._devices;
    }

    get(index: number): TunerDevice {

        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].index === index) {
                return this._devices[i];
            }
        }

        return null;
    }

    typeExists(type: common.ChannelType): boolean {

        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].config.types.indexOf(type) !== -1) {
                return true;
            }
        }

        return false;
    }

    getChannelStream(channel: ChannelItem, userReq: common.UserRequest): Promise<stream.Readable> {

        let networkId: number;

        const services = channel.getServices();
        if (services.length !== 0) {
            networkId = services[0].networkId;
        }

        return this._getStream({
            ...userReq,
            streamSetting: {
                channel: channel,
                networkId: networkId,
                parseEIT: true
            }
        });
    }

    getServiceStream(service: ServiceItem, userReq: common.UserRequest): Promise<stream.Readable> {

        return this._getStream({
            ...userReq,
            streamSetting: {
                channel: service.channel,
                serviceId: service.serviceId,
                networkId: service.networkId,
                parseEIT: true
            }
        });
    }

    getProgramStream(program: ProgramItem, userReq: common.UserRequest): Promise<stream.Readable> {

        return this._getStream({
            ...userReq,
            streamSetting: {
                channel: program.service.channel,
                serviceId: program.data.serviceId,
                eventId: program.data.eventId,
                networkId: program.data.networkId,
                parseEIT: true
            }
        });
    }

    async getEPG(channel: ChannelItem, time?: number): Promise<void> {

        if (!time) {
            time = _.config.server.epgRetrievalTime || 1000 * 60 * 10;
        }

        let networkId;

        const services = channel.getServices();
        if (services.length !== 0) {
            networkId = services[0].networkId;
        }

        const stream = await this._getStream({
            id: "Mirakurun:getEPG()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel: channel,
                networkId: networkId,
                noProvide: true,
                parseEIT: true
            }
        });
        if (stream === null) {
            return Promise.resolve();
        } else {
            return new Promise<void>((resolve) => {
                setTimeout(() => stream.emit("close"), time);
                stream.once("epgReady", () => stream.emit("close"));
                stream.once("close", resolve);
            });
        }
    }

    async getServices(channel: ChannelItem): Promise<db.Service[]> {

        const stream = await this._getStream({
            id: "Mirakurun:getServices()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel: channel,
                noProvide: true,
                parseNIT: true,
                parseSDT: true
            }
        });
        return new Promise<db.Service[]>((resolve, reject) => {

            let network = {
                networkId: -1,
                areaCode: -1,
                remoteControlKeyId: -1
            };
            let services: db.Service[] = null;

            setTimeout(() => stream.emit("close"), 20000);

            Promise.all<void>([
                new Promise((resolve, reject) => {
                    stream.once("network", _network => {
                        network = _network;
                        resolve();
                    });
                }),
                new Promise((resolve, reject) => {
                    stream.once("services", _services => {
                        services = _services;
                        resolve();
                    });
                })
            ]).then(() => stream.emit("close"));

            stream.once("close", () => {

                stream.removeAllListeners("network");
                stream.removeAllListeners("services");

                if (network.networkId === -1) {
                    reject(new Error("stream has closed before get network"));
                } else if (services === null) {
                    reject(new Error("stream has closed before get services"));
                } else {
                    if (network.remoteControlKeyId !== -1) {
                        services.forEach(service => {
                            service.remoteControlKeyId = network.remoteControlKeyId;
                        });
                    }

                    resolve(services);
                }
            });
        });
    }

    private _load(): this {

        log.debug("loading tuners...");

        const tuners = _.config.tuners;

        tuners.forEach((tuner, i) => {

            if (!tuner.name || !tuner.types || (!tuner.remoteMirakurunHost && !tuner.command)) {
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

            if (!tuner.remoteMirakurunHost && typeof tuner.command !== "string") {
                log.error("invalid type of property `command` in tuner#%s configuration", i);
                return;
            }

            if (tuner.dvbDevicePath && typeof tuner.dvbDevicePath !== "string") {
                log.error("invalid type of property `dvbDevicePath` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunHost && typeof tuner.remoteMirakurunHost !== "string") {
                log.error("invalid type of property `remoteMirakurunHost` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunPort && Number.isInteger(tuner.remoteMirakurunPort) === false) {
                log.error("invalid type of property `remoteMirakurunPort` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunDecoder !== undefined && typeof tuner.remoteMirakurunDecoder !== "boolean") {
                log.error("invalid type of property `remoteMirakurunDecoder` in tuner#%s configuration", i);
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

    private _getStream(user: common.User): Promise<stream.Readable> {

        return new Promise<stream.Readable>((resolve, reject) => {

            const setting = user.streamSetting;

            if (_.config.server.disableEITParsing === true) {
                setting.parseEIT = false;
            }

            const devices = this._getDevicesByType(setting.channel.type);

            let tryCount = 50;
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

                // x. use remote data
                if (device === null && setting.noProvide === true) {
                    const remoteDevice = devices.find(device => device.isRemote);
                    if (remoteDevice) {
                        if (setting.networkId !== undefined && setting.parseEIT === true) {
                            remoteDevice.getRemotePrograms({ networkId: setting.networkId })
                                .then(async programs => {
                                    await common.sleep(1000);
                                    _.program.findByNetworkIdAndReplace(setting.networkId, programs);
                                    await common.sleep(1000);
                                })
                                .then(() => resolve(null))
                                .catch(err => reject(err));

                            return;
                        }
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
                    devices.sort((t1, t2) => {
                        return t1.getPriority() - t2.getPriority();
                    });

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
                        parseNIT: setting.parseNIT,
                        parseSDT: setting.parseSDT,
                        parseEIT: setting.parseEIT
                    });

                    Object.defineProperty(user, "streamInfo", {
                        get: () => tsFilter.streamInfo
                    });

                    device.startStream(user, tsFilter, setting.channel)
                        .then(() => {
                            if (user.disableDecoder === true || device.decoder === null) {
                                resolve(tsFilter);
                            } else {
                                const decoder = child_process.spawn(device.decoder);
                                ++status.streamCount.decoder;
                                decoder.stderr.pipe(process.stderr);
                                decoder.stdout.once("close", () => {
                                    tsFilter.emit("close");
                                    --status.streamCount.decoder;
                                });
                                decoder.stdin.once("finish", () => decoder.kill("SIGKILL"));
                                tsFilter.once("close", () => decoder.stdin.end());
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

        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].config.types.indexOf(type) !== -1) {
                devices.push(this._devices[i]);
            }
        }

        return devices;
    }
}
