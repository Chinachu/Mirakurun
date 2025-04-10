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
import * as apid from "../../api";
import _ from "./_";
import TunerDevice, { TunerDeviceStatus } from "./TunerDevice";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";
import TSFilter from "./TSFilter";
import TSDecoder from "./TSDecoder";

export class Tuner {
    private _devices: TunerDevice[] = [];
    private _readyForJobPickedDeviceSet: Set<TunerDevice> = new Set();

    constructor() {
        this._load();
    }

    get devices(): TunerDeviceStatus[] {
        return this._devices.map(device => device.toJSON());
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

    /**
     * readyFn
     */
    async readyForJob(channel: ChannelItem): Promise<boolean> {
        const devices = this._getDevicesByType(channel.type);
        if (devices.length === 0) {
            log.error("readyForJob: no tuners for channel type: %s", channel.type);
            return false;
        }

        while (true) {
            const pickableDevices = devices.filter(device => !this._readyForJobPickedDeviceSet.has(device));
            if (pickableDevices.length === 0) {
                log.debug("readyForJob: no pickable tuners for channel type: %s", channel.type);
                await common.sleep(1000 * 10);
                continue;
            }
            const device = this._pickTunerDevice(pickableDevices, channel, -1);
            if (device === null) {
                // log.debug("readyForJob: no available tuners for channel type: %s", channel.type);
                await common.sleep(1000 * 10);
                continue;
            }
            // pick したチューナーを少し保持する
            this._readyForJobPickedDeviceSet.add(device);
            log.debug("readyForJob: picked device: #%d (%s)", device.config.name);

            setTimeout(() => {
                // 開放
                this._readyForJobPickedDeviceSet.delete(device);
                log.debug("readyForJob: released device: #%d (%s)", device.index, device.config.name);
            }, 1000 * 5);

            return true;
        }
    }

    typeExists(type: apid.ChannelType): boolean {
        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].config.types.includes(type) === true) {
                return true;
            }
        }

        return false;
    }

    initChannelStream(channel: ChannelItem, userReq: common.UserRequest, output: Writable): Promise<TSFilter> {
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

    initServiceStream(service: ServiceItem, userReq: common.UserRequest, output: Writable): Promise<TSFilter> {
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

    initProgramStream(program: apid.Program, userReq: common.UserRequest, output: Writable): Promise<TSFilter> {
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
        let timeout: NodeJS.Timeout;
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

    async getServices(channel: ChannelItem, user: Partial<common.User> = {}): Promise<apid.Service[]> {
        const tsFilter = await this._initTS({
            id: "Mirakurun:getServices()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
                parseNIT: true,
                parseSDT: true
            },
            ...user
        });
        return new Promise<apid.Service[]>((resolve, reject) => {
            let network = {
                networkId: -1,
                areaCode: -1,
                remoteControlKeyId: -1
            };
            let services: apid.Service[] = null;

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

    private async _initTS(user: common.User, dest?: Writable): Promise<TSFilter | null> {
        const setting = user.streamSetting;

        if (_.config.server.disableEITParsing === true) {
            setting.parseEIT = false;
        }

        const devices = this._getDevicesByType(setting.channel.type);
        let tryCount = 50;

        if (!dest) {
            const remoteResult = await this._useRemoteData(user, devices);
            if (remoteResult) {
                return null;
            }
        }

        while (tryCount > 0) {
            const device = this._pickTunerDevice(devices, setting.channel, user.priority);

            if (device === null) {
                // retry
                tryCount--;
                if (tryCount <= 0) {
                    throw new Error("no available tuners");
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            } else {
                // found
                let output: Writable;
                if (user.disableDecoder === true || device.decoder === null) {
                    output = dest;
                } else {
                    output = new TSDecoder({
                        output: dest,
                        command: device.decoder
                    });
                }

                const tsFilter = new TSFilter({
                    output,
                    networkId: setting.networkId,
                    serviceId: setting.serviceId,
                    eventId: setting.eventId,
                    parseNIT: setting.parseNIT,
                    parseSDT: setting.parseSDT,
                    parseEIT: setting.parseEIT,
                    tsmfRelTs: setting.channel.tsmfRelTs
                });

                Object.defineProperty(user, "streamInfo", {
                    get: () => tsFilter.streamInfo
                });

                try {
                    await device.startStream(user, tsFilter, setting.channel);
                    return tsFilter;
                } catch (err) {
                    tsFilter.end();
                    throw err;
                }
            }
        }
    }

    /**
     * リモートデータ利用 (EPG)
     */
    private async _useRemoteData(
        user: common.User,
        devices: TunerDevice[]
    ): Promise<boolean> {
        const setting = user.streamSetting;

        const remoteDevice = devices.find(device => device.isRemote);
        if (remoteDevice && setting.networkId !== undefined && setting.parseEIT === true) {
            try {
                const programs = await remoteDevice.getRemotePrograms({ networkId: setting.networkId });
                await common.sleep(1000);
                _.program.findByNetworkIdAndReplace(setting.networkId, programs);
                for (const service of _.service.findByNetworkId(setting.networkId)) {
                    service.epgReady = true;
                }
                await common.sleep(1000);
                return true;
            } catch (err) {
                throw err;
            }
        }

        return false;
    }

    /**
     * チューナーデバイス探索
     */
    private _pickTunerDevice(
        devices: TunerDevice[],
        channel: ChannelItem,
        priority: number
    ): TunerDevice | null {
        // 1. join to existing
        for (const device of devices) {
            if (device.isAvailable === true && device.channel === channel) {
                return device;
            }
        }

        // 2. start as new
        for (const device of devices) {
            if (device.isFree === true) {
                return device;
            }
        }

        // 3. replace existing
        for (const device of devices) {
            if (device.isAvailable === true && device.users.length === 0) {
                return device;
            }
        }

        // 4. takeover existing
        if (priority >= 0) {
            devices.sort((t1, t2) => t1.getPriority() - t2.getPriority());
            for (const device of devices) {
                if (device.isUsing === true && device.getPriority() < priority) {
                    return device;
                }
            }
        }

        return null;
    }

    private _getDevicesByType(type: apid.ChannelType): TunerDevice[] {
        const devices = [];

        for (const device of this._devices) {
            if (device.config.types.includes(type) === true) {
                devices.push(device);
            }
        }

        return devices;
    }
}

export default Tuner;
