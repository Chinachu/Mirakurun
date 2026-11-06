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
import EventEmitter = require("eventemitter3");
import * as common from "./common";
import * as log from "./log";
import * as apid from "../../api";
import _ from "./_";
import TunerDevice, { TunerDeviceStatus } from "./TunerDevice";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";
import TSFilter from "./TSFilter";
import TSDecoder from "./TSDecoder";
import { DETECT_BYTES, DETECT_SKIP_BYTES, detectStreamFormat, detectTSMFStreamFormat } from "./StreamFormat";

// the TLV decoders (descrambling via a server, converting) take a while to output
const TLV_DECODER_STARTUP_TIMEOUT = 10000;
// milliseconds to receive the data to detect the format
const DETECT_TIMEOUT = 10000;

/** receives the data of a tuner to detect the format */
class FormatProbe extends EventEmitter {
    private _chunks: Buffer[] = [];
    private _bytes = 0;
    private _closed = false;
    private _resolve: (format: apid.StreamFormat | null) => void = null;

    constructor(private _detect: (data: Buffer) => apid.StreamFormat | null) {
        super();
    }

    get closed(): boolean {
        return this._closed;
    }

    detect(timeout: number): Promise<apid.StreamFormat | null> {
        return new Promise(resolve => {
            const timer = setTimeout(() => this._done(null), timeout);
            this._resolve = format => {
                clearTimeout(timer);
                resolve(format);
            };
        });
    }

    write(chunk: Buffer): void {
        if (this._closed || this._resolve === null) {
            return;
        }
        this._chunks.push(chunk);
        this._bytes += chunk.length;
        if (this._bytes >= DETECT_SKIP_BYTES + DETECT_BYTES) {
            const data = Buffer.concat(this._chunks, this._bytes);
            this._chunks = [];
            this._done(this._detect(data.subarray(DETECT_SKIP_BYTES)));
        }
    }

    flush(): void {
        // nothing to output
    }

    end(): void {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this._chunks = [];
        this._done(null);
        this.emit("close");
    }

    private _done(format: apid.StreamFormat | null): void {
        if (this._resolve !== null) {
            const resolve = this._resolve;
            this._resolve = null;
            resolve(format);
        }
    }
}

interface TunerCandidate {
    channel: ChannelItem;
    devices: TunerDevice[];
}

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
     * @param channels candidates, the former is preferred
     * @returns the channel a tuner is available for, `null` if no tuners for the channels
     */
    async readyForJob(channels: ChannelItem | ChannelItem[]): Promise<ChannelItem> {
        const candidates = this._getCandidates(Array.isArray(channels) ? channels : [channels]);
        if (candidates.every(candidate => candidate.devices.length === 0)) {
            log.error("readyForJob: no tuners for channel %s", candidates.map(({ channel }) => `${channel.type}/${channel.channel}`).join(", "));
            return null;
        }

        while (true) {
            const picked = this._pickTunerDevice(
                candidates.map(({ channel, devices }) => ({
                    channel,
                    devices: devices.filter(device => !this._readyForJobPickedDeviceSet.has(device))
                })),
                -1
            );
            if (picked === null) {
                // log.debug("readyForJob: no available tuners for channel type: %s", channel.type);
                await common.sleep(1000 * 10);
                continue;
            }
            const { device, channel } = picked;
            // pick したチューナーを少し保持する
            this._readyForJobPickedDeviceSet.add(device);
            log.debug("readyForJob: picked device: #%d (%s) for %s/%s", device.index, device.config.name, channel.type, channel.channel);

            setTimeout(() => {
                // 開放
                this._readyForJobPickedDeviceSet.delete(device);
                log.debug("readyForJob: released device: #%d (%s)", device.index, device.config.name);
            }, 1000 * 5);

            return channel;
        }
    }

    typeExists(type: apid.ChannelType, route?: apid.ChannelRoute): boolean {
        return this._getDevicesByType(type, route).length > 0;
    }

    /**
     * the output format of the stream request
     * @returns `null` if the format is unavailable
     */
    getOutputFormat(channels: ChannelItem[], requested?: apid.StreamFormat): apid.StreamFormat | null {
        const tlvChannels = channels.filter(channel => channel.isTlv);
        if (tlvChannels.length === 0) {
            return requested === "tlv" ? null : "ts";
        }

        // the channels of TS can output TS without the conversion
        const canConvert = tlvChannels.length < channels.length ||
            this._getCandidates(tlvChannels).some(({ devices }) => devices.some(device => !!device.config.tlvToTsDecoder));
        const format = requested || _.config.server.defaultTlvStreamFormat || "tlv";
        if (format === "ts" && canConvert === false) {
            return null;
        }
        return format;
    }

    initChannelStream(channel: ChannelItem, userReq: common.UserRequest, output: Writable): Promise<common.StreamFilter> {
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

    initServiceStream(service: ServiceItem, userReq: common.UserRequest, output: Writable): Promise<common.StreamFilter> {
        const channels = service.channels;
        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: channels[0],
                serviceId: service.serviceId,
                networkId: service.networkId,
                parseEIT: true
            }
        }, output, channels);
    }

    initProgramStream(program: apid.Program, userReq: common.UserRequest, output: Writable): Promise<common.StreamFilter> {
        const channels = _.service.get(program.networkId, program.serviceId).channels;
        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: channels[0],
                serviceId: program.serviceId,
                eventId: program.eventId,
                networkId: program.networkId,
                parseEIT: true
            }
        }, output, channels);
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
        const userReq: common.User = {
            id: "Mirakurun:getServices()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
                parseNIT: true,
                parseSDT: true
            },
            ...user
        };
        return this._scanServices(channel, userReq, channel.format, true);
    }

    /**
     * @param format the format to receive the stream
     * @param detect `true` to detect the format (only by the service scan, the streams use the format detected)
     */
    private async _scanServices(channel: ChannelItem, userReq: common.User, format: apid.StreamFormat, detect: boolean): Promise<apid.Service[]> {
        const tsFilter = await this._initTS(userReq, undefined, undefined, format);
        // the format is detected by the data of the same tuner, the scan does not wait for it
        const probe = detect ? this._startFormatProbe(userReq) : null;
        return new Promise<apid.Service[]>((resolve, reject) => {
            let network = {
                networkId: -1,
                areaCode: -1,
                remoteControlKeyId: -1
            };
            let services: apid.Service[] = null;
            let retryFormat: apid.StreamFormat = null;

            const timeout = setTimeout(() => tsFilter.close(), 20000);

            probe?.format.then(detected => {
                // the scan has succeeded in the format
                if (detected === null || detected === format || tsFilter.closed || (network.networkId !== -1 && services !== null)) {
                    return;
                }
                log.info("Tuner: the format of %s/%s is detected as `%s`, scanning again", channel.type, channel.channel, detected);
                retryFormat = detected;
                tsFilter.close();
            });

            Promise.all<void>([
                new Promise((resolve, reject) => {
                    // CATV では自身の TS のセクションが後から届くため、最後に通知されたものを使う
                    tsFilter.on("network", _network => {
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
                clearTimeout(timeout);
                probe?.end();

                if (retryFormat !== null) {
                    // the tuner is kept tuned for a while, the stream of the scan joins it
                    resolve(this._scanServices(channel, userReq, retryFormat, false));
                } else if (network.networkId === -1) {
                    reject(new Error("stream has closed before get network"));
                } else if (services === null) {
                    reject(new Error("stream has closed before get services"));
                } else {
                    if (services.length > 0 && _.channel.get(channel.type, channel.channel) === channel) {
                        channel.setStream(services[0].networkId, services[0].streamId, format);
                    }
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

            if (
                tuner.routes !== undefined &&
                (Array.isArray(tuner.routes) === false || tuner.routes.some(route => common.channelRoutes.includes(route) === false))
            ) {
                log.error("invalid type of property `routes` in tuner#%s configuration", i);
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

            if (tuner.disableDvbDirect !== undefined && typeof tuner.disableDvbDirect !== "boolean") {
                log.error("invalid type of property `disableDvbDirect` in tuner#%s configuration", i);
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

    /**
     * detects the format of the stream by joining the tuner streaming to `user` (does not tune by itself)
     * @returns `null` if the format is not detected: the remote Mirakurun outputs the format by itself,
     * and only the tuners for TLV (MMT) detect, not to add any work to the environments only for TS
     */
    private _startFormatProbe(user: common.User): { format: Promise<apid.StreamFormat | null>, end: () => void } | null {
        // the ID of the scan is not unique (the scans run on the tuners at the same time), `streamSetting` is of this scan
        const device = this._devices.find(device => device.users.some(deviceUser => deviceUser.streamSetting === user.streamSetting));
        if (!device || device.isRemote) {
            return null;
        }
        const { types, tlvDecoder, tlvToTsDecoder } = device.config;
        if (!tlvDecoder && !tlvToTsDecoder && types.some(type => common.tlvChannelTypes.includes(type)) === false) {
            return null;
        }

        // TSMF is TS outside, the relative stream is detected by the header
        const channel = user.streamSetting.channel;
        const probe = new FormatProbe(channel.tsmfRelTs ? data => detectTSMFStreamFormat(data, channel.tsmfRelTs) : detectStreamFormat);
        const format = probe.detect(DETECT_TIMEOUT).then(detected => {
            probe.end();
            return detected;
        });
        device.startStream({ ...user, id: `${user.id}#format` }, probe).catch(err => {
            log.debug("Tuner: the format detection has failed (%s)", err.message);
            probe.end();
        });
        return { format, end: () => probe.end() };
    }

    /**
     * @param channels candidate channels carrying the same stream (default: `streamSetting.channel`)
     * @param format the format detected (default: `format` of the channel)
     */
    private async _initTS(user: common.User, dest?: Writable, channels?: ChannelItem[], format?: apid.StreamFormat): Promise<common.StreamFilter | null> {
        const setting = user.streamSetting;

        if (_.config.server.disableEITParsing === true) {
            setting.parseEIT = false;
        }

        let candidates = this._getCandidates(channels || [setting.channel]);
        // the format detected is only for `streamSetting.channel`
        const isTlvChannel = (channel: ChannelItem) => (channels === undefined && format) ? format === "tlv" : channel.isTlv;
        if (dest && user.outputFormat) {
            candidates = candidates.map(({ channel, devices }) => {
                if (isTlvChannel(channel)) {
                    // only the tuners can convert TLV to TS
                    return { channel, devices: user.outputFormat === "ts" ? devices.filter(device => !!device.config.tlvToTsDecoder) : devices };
                }
                // the channels of TS cannot output TLV
                return { channel, devices: user.outputFormat === "tlv" ? [] : devices };
            });
        }
        let tryCount = 50;
        const startedAt = Date.now();

        if (!dest) {
            const remoteResult = await this._useRemoteData(user, candidates.flatMap(candidate => candidate.devices));
            if (remoteResult) {
                return null;
            }
        }

        while (tryCount > 0) {
            const picked = this._pickTunerDevice(candidates, user.priority);

            if (picked === null) {
                // retry
                tryCount--;
                if (tryCount <= 0) {
                    throw new Error("no available tuners");
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            } else {
                // found
                const { device, channel } = picked;
                const isTlv = isTlvChannel(channel);
                setting.channel = channel;
                log.debug("Tuner: picked TunerDevice#%d for user `%s` in %dms", device.index, user.id, Date.now() - startedAt);

                let tsFilter: common.StreamFilter;
                if (isTlv) {
                    // Keep MMT parsing modules out of the existing TS-only path.
                    const TLVFilter = (require("./TLVFilter") as typeof import("./TLVFilter")).default;
                    tsFilter = new TLVFilter({
                        output: this._getTlvOutput(device, user, dest),
                        networkId: setting.networkId,
                        serviceId: setting.serviceId,
                        eventId: setting.eventId,
                        parseNIT: setting.parseNIT,
                        parseSDT: setting.parseSDT,
                        parseEIT: setting.parseEIT,
                        tsmfRelTs: setting.channel.tsmfRelTs
                    });
                } else {
                    let output: Writable;
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
     * TLV: TLVFilter -> [tlvDecoder] -> [tlvToTsDecoder] -> dest
     */
    private _getTlvOutput(device: TunerDevice, user: common.User, dest?: Writable): Writable {
        if (!dest) {
            return dest;
        }

        let output = dest;
        if (user.outputFormat === "ts") {
            // a stream in TS must not be continued in TLV
            output = new TSDecoder({
                output,
                command: device.config.tlvToTsDecoder,
                withArgs: true,
                startupTimeout: TLV_DECODER_STARTUP_TIMEOUT,
                passThroughOnFailure: false
            });
        }
        if (user.disableDecoder !== true && device.config.tlvDecoder && !device.isRemote) {
            output = new TSDecoder({
                output,
                command: device.config.tlvDecoder,
                withArgs: true,
                startupTimeout: TLV_DECODER_STARTUP_TIMEOUT
            });
        }
        return output;
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
     * 各段階で、すべての候補のチャンネルを順に探す (前の候補を優先する)
     */
    private _pickTunerDevice(
        candidates: TunerCandidate[],
        priority: number
    ): { device: TunerDevice, channel: ChannelItem } | null {
        // 1. join to existing
        for (const { channel, devices } of candidates) {
            for (const device of devices) {
                if (device.isAvailable === true && device.channel === channel) {
                    return { device, channel };
                }
            }
        }

        // 2. start as new
        for (const { channel, devices } of candidates) {
            for (const device of devices) {
                if (device.isFree === true) {
                    return { device, channel };
                }
            }
        }

        // 3. replace existing
        for (const { channel, devices } of candidates) {
            for (const device of devices) {
                if (device.isAvailable === true && device.users.length === 0) {
                    return { device, channel };
                }
            }
        }

        // 4. takeover existing
        if (priority >= 0) {
            const targets = candidates.flatMap(({ channel, devices }) => devices.map(device => ({ device, channel })));
            targets.sort((t1, t2) => t1.device.getPriority() - t2.device.getPriority());
            for (const target of targets) {
                if (target.device.isUsing === true && target.device.getPriority() < priority) {
                    return target;
                }
            }
        }

        return null;
    }

    private _getCandidates(channels: ChannelItem[]): TunerCandidate[] {
        return channels.map(channel => ({
            channel,
            devices: this._getDevicesByType(channel.type, channel.route)
        }));
    }

    private _getDevicesByType(type: apid.ChannelType, route?: apid.ChannelRoute): TunerDevice[] {
        const devices = [];

        for (const device of this._devices) {
            if (
                device.config.types.includes(type) === true &&
                (route === undefined || !device.config.routes || device.config.routes.includes(route) === true)
            ) {
                devices.push(device);
            }
        }

        return devices;
    }
}

export default Tuner;
