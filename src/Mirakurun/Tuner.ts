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
import { Writable } from "stream";
import * as common from "./common";
import * as log from "./log";
import * as db from "./db";
import _ from "./_";
import TunerDevice from "./TunerDevice";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";
import TSFilter from "./TSFilter";
import TSDecoder from "./TSDecoder";
import TLVFilter from "./TLVFilter";
import { StreamFilter } from "./StreamFilter";

export default class Tuner {

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
            if (this._devices[i].config.types.includes(type) === true) {
                return true;
            }
        }

        return false;
    }

    initChannelStream(channel: ChannelItem, userReq: common.UserRequest, output: Writable): Promise<StreamFilter> {

        let networkId: number;

        const services = channel.getServices();
        if (services.length !== 0) {
            networkId = services[0].networkId;
        }

        return this._initTS({
            ...userReq,
            streamSetting: {
                channel,
                networkId,
                parseEIT: true
            }
        }, output);
    }

    initServiceStream(service: ServiceItem, userReq: common.UserRequest, output: Writable): Promise<StreamFilter> {

        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: service.channel,
                serviceId: service.serviceId,
                networkId: service.networkId,
                parseEIT: true
            }
        }, output);
    }

    initProgramStream(program: db.Program, userReq: common.UserRequest, output: Writable): Promise<StreamFilter> {

        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: _.service.get(program.networkId, program.serviceId).channel,
                serviceId: program.serviceId,
                eventId: program.eventId,
                networkId: program.networkId,
                parseEIT: true
            }
        }, output);
    }

    async getEPG(channel: ChannelItem, time?: number): Promise<void> {

        let timeout: NodeJS.Timer;
        if (!time) {
            time = _.config.server.epgRetrievalTime || 1000 * 60 * 10;
        }

        let networkId: number;

        const services = channel.getServices();
        if (services.length === 0) {
            throw new Error("no available services in channel");
        }

        networkId = services[0].networkId;

        const tsFilter = await this._initTS({
            id: "Mirakurun:getEPG()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
                networkId,
                parseEIT: true
            }
        });

        if (tsFilter === null) {
            return;
        }

        return new Promise<void>((resolve) => {
            const fin = () => {
                clearTimeout(timeout);
                tsFilter.close();
            };
            timeout = setTimeout(fin, time);
            tsFilter.once("epgReady", fin);
            tsFilter.once("close", () => {
                fin();
                resolve();
            });
        });
    }

    async getServices(channel: ChannelItem): Promise<db.Service[]> {

        const tsFilter = await this._initTS({
            id: "Mirakurun:getServices()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
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

            setTimeout(() => tsFilter.close(), 20000);

            Promise.all<void>([
                new Promise((resolve, reject) => {
                    tsFilter.once("network", _network => {
                        network = _network;
                        resolve();
                    });
                }),
                new Promise((resolve, reject) => {
                    tsFilter.once("services", _services => {
                        services = _services;
                        resolve();
                    });
                })
            ]).then(() => tsFilter.close());

            tsFilter.once("close", () => {

                tsFilter.removeAllListeners("network");
                tsFilter.removeAllListeners("services");

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

    private _initTS(user: common.User, dest?: Writable): Promise<StreamFilter> {

        return new Promise<StreamFilter>((resolve, reject) => {

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
                if (device === null && !dest) {
                    const remoteDevice = devices.find(device => device.isRemote);
                    if (remoteDevice) {
                        if (setting.networkId !== undefined && setting.parseEIT === true) {
                            remoteDevice.getRemotePrograms({ networkId: setting.networkId })
                                .then(async programs => {
                                    await common.sleep(1000);
                                    _.program.findByNetworkIdAndReplace(setting.networkId, programs);
                                    for (const service of _.service.findByNetworkId(setting.networkId)) {
                                        service.epgReady = true;
                                    }
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
                    let output: Writable;

                    let tsFilter: StreamFilter;
                    if (setting.channel.type === "BS4K") {
                        if (user.disableDecoder === true || device.tlvDecoder === null) {
                            output = dest;
                        } else {
                            output = new TSDecoder({
                                output: dest,
                                command: device.tlvDecoder
                            });
                        }
                        tsFilter = new TLVFilter({
                            output,
                            networkId: setting.networkId,
                            serviceId: setting.serviceId,
                            eventId: setting.eventId,
                            parseNIT: setting.parseNIT,
                            parseSDT: setting.parseSDT,
                            parseEIT: setting.parseEIT,
                            tsmfRelTs: setting.channel.tsmfRelTs,
                            channel: setting.channel.channel
                        });
                    } else {
                        if (user.disableDecoder === true || device.decoder === null) {
                            output = dest;
                        } else {
                            output = new TSDecoder({
                                output: dest,
                                command: device.decoder
                            });
                        }
                        tsFilter = new TSFilter({
                            output,
                            networkId: setting.networkId,
                            serviceId: setting.serviceId,
                            eventId: setting.eventId,
                            parseNIT: setting.parseNIT,
                            parseSDT: setting.parseSDT,
                            parseEIT: setting.parseEIT,
                            tsmfRelTs: setting.channel.tsmfRelTs
                        });
                    }

                    Object.defineProperty(user, "streamInfo", {
                        get: () => tsFilter.streamInfo
                    });

                    device.startStream(user, tsFilter, setting.channel)
                        .then(() => {
                            resolve(tsFilter);
                        })
                        .catch((err) => {
                            tsFilter.end();
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
            if (this._devices[i].config.types.includes(type) === true) {
                devices.push(this._devices[i]);
            }
        }

        return devices;
    }
}
