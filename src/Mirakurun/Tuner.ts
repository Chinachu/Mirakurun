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
import type TLVFilter from "./TLVFilter";
import TSDecoder from "./TSDecoder";
import { DETECT_BYTES, DETECT_SKIP_BYTES, TSMFStream, detectStreamFormat, detectTSMFStreamFormat, detectTSMFStreams } from "./StreamFormat";

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

/** the output of a tuner of a bonded carrier, to the TLVFilter of the first carrier */
class CarrierSink extends EventEmitter {
    private _closed = false;

    constructor(private _filter: TLVFilter, private _carrier: number) {
        super();
        if (_filter.closed) {
            this._closed = true;
        } else {
            _filter.once("close", () => this.end());
        }
    }

    get closed(): boolean {
        return this._closed;
    }

    write(chunk: Buffer, defer = false): void {
        this._filter.writeCarrier(this._carrier, chunk, defer);
    }

    flush(): void {
        this._filter.flush();
    }

    /** the stream can not continue without a carrier */
    end(): void {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this._filter.close();
        this.emit("close");
    }
}

/** a channel and the relative stream of TSMF to receive */
export interface StreamTarget {
    channel: ChannelItem;
    /** the relative stream of TSMF */
    relTs?: number;
}

interface TunerCandidate extends StreamTarget {
    devices: TunerDevice[];
    /** the format to receive */
    format: apid.StreamFormat;
}

interface DetectedFormat {
    format: apid.StreamFormat;
    /** the relative streams of TSMF (detected only if `tsmfRelTs` of the channel is not specified) */
    tsmf: TSMFStream[] | null;
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
     * @param channels candidates (and the relative streams of TSMF), the former is preferred
     * @returns the channel a tuner is available for, `null` if no tuners for the channels
     */
    async readyForJob(channels: ChannelItem | (ChannelItem | StreamTarget)[]): Promise<ChannelItem> {
        const candidates = this._getCandidates(
            (Array.isArray(channels) ? channels : [channels]).map(target => target instanceof ChannelItem ? { channel: target } : target)
        );
        if (candidates.every(candidate => candidate.devices.length === 0)) {
            log.error("readyForJob: no tuners for channel %s", candidates.map(({ channel }) => `${channel.type}/${channel.channel}`).join(", "));
            return null;
        }

        while (true) {
            const picked = this._pickTunerDevice(
                candidates.map(candidate => ({
                    ...candidate,
                    devices: candidate.devices.filter(device => !this._readyForJobPickedDeviceSet.has(device))
                })),
                -1
            );
            // the bonded carriers need the tuners too
            const carriers = picked === null ? null : this._pickCarrierDevices(picked, -1, this._readyForJobPickedDeviceSet);
            if (picked === null || carriers === null) {
                // log.debug("readyForJob: no available tuners for channel type: %s", channel.type);
                await common.sleep(1000 * 10);
                continue;
            }
            const { channel } = picked;
            // pick したチューナーを少し保持する
            for (const { device } of [picked, ...carriers]) {
                this._readyForJobPickedDeviceSet.add(device);
                log.debug("readyForJob: picked device: #%d (%s) for %s/%s", device.index, device.config.name, channel.type, channel.channel);

                setTimeout(() => {
                    // 開放
                    this._readyForJobPickedDeviceSet.delete(device);
                    log.debug("readyForJob: released device: #%d (%s)", device.index, device.config.name);
                }, 1000 * 5);
            }

            return channel;
        }
    }

    typeExists(type: apid.ChannelType, route?: apid.ChannelRoute): boolean {
        return this._getDevicesByType(type, route).length > 0;
    }

    /**
     * the output format of the stream request
     * @param targets the channels (and the relative streams of TSMF) to receive the stream
     * @returns `null` if the format is unavailable
     */
    getOutputFormat(targets: StreamTarget[], requested?: apid.StreamFormat): apid.StreamFormat | null {
        const tlvTargets = targets
            .map(({ channel, relTs }) => ({ channel, relTs: this._getReceivableRelTs(channel, relTs) }))
            .filter(({ channel, relTs }) => channel.getFormat(relTs) === "tlv");
        if (tlvTargets.length === 0) {
            return requested === "tlv" ? null : "ts";
        }

        // the streams of TS can output TS without the conversion
        const canConvert = tlvTargets.length < targets.length ||
            this._getCandidates(tlvTargets).some(({ devices }) => devices.some(device => !!device.config.tlvToTsDecoder));
        const format = requested || _.config.server.defaultTlvStreamFormat || "tlv";
        if (format === "ts" && canConvert === false) {
            return null;
        }
        return format;
    }

    /** @param relTs the relative stream of TSMF (default: `tsmfRelTs` of the channel, the stream as received if not specified) */
    initChannelStream(channel: ChannelItem, userReq: common.UserRequest, output: Writable, relTs?: number): Promise<common.StreamFilter> {
        let networkId: number;

        relTs = relTs || channel.tsmfRelTs;
        // the relative stream detected specified is not received by the remote tuners
        if (relTs !== channel.tsmfRelTs && this._getReceivableRelTs(channel, relTs) !== relTs) {
            return Promise.reject(new Error("no available tuners"));
        }

        const stream = channel.getStreamByRelTs(relTs);
        const services = channel.getServices();
        // the stream as received of TSMF detected is TS (the services of TLV are of the other networks)
        const tsmfTS = relTs === undefined && stream === null ? channel.streams
            .filter(item => item.relTs !== undefined && item.format === "ts")
            .sort((a, b) => b.slots - a.slots || a.relTs - b.relTs)[0] : undefined;
        if (stream !== null) {
            networkId = stream.networkId;
        } else if (tsmfTS) {
            networkId = tsmfTS.networkId;
        } else if (services.length !== 0) {
            networkId = services[0].networkId;
        }

        return this._initTS({
            ...userReq,
            streamSetting: {
                channel,
                networkId,
                parseEIT: true
            }
        }, output, [this._getCandidate(channel, relTs)]);
    }

    /** @param targets the channels to receive the service (default: `targets` of the service) */
    initServiceStream(service: ServiceItem, userReq: common.UserRequest, output: Writable, targets: StreamTarget[] = service.targets): Promise<common.StreamFilter> {
        const candidates = this._getCandidates(targets);
        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: candidates[0].channel,
                serviceId: service.serviceId,
                networkId: service.networkId,
                parseEIT: true
            }
        }, output, candidates);
    }

    initProgramStream(program: apid.Program, userReq: common.UserRequest, output: Writable): Promise<common.StreamFilter> {
        const candidates = this._getCandidates(_.service.get(program.networkId, program.serviceId).targets);
        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: candidates[0].channel,
                serviceId: program.serviceId,
                eventId: program.eventId,
                networkId: program.networkId,
                parseEIT: true
            }
        }, output, candidates);
    }

    /** @param relTs the relative stream of TSMF (default: `defaultRelTs` of the channel) */
    async getEPG(channel: ChannelItem, time?: number, relTs?: number): Promise<void> {
        let timeout: NodeJS.Timeout;
        if (!time) {
            time = _.config.server.epgRetrievalTime || 1000 * 60 * 10;
        }

        let networkId: number;

        const services = channel.getServices();
        if (services.length === 0) {
            throw new Error("no available services in channel");
        }

        relTs = relTs || channel.defaultRelTs;
        networkId = channel.getStreamByRelTs(relTs)?.networkId ?? services[0].networkId;

        const tsFilter = await this._initTS({
            id: "Mirakurun:getEPG()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
                networkId,
                parseEIT: true
            }
        }, undefined, [this._getCandidate(channel, relTs)]);

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
        return this._scanServices(channel, userReq, channel.getFormat(channel.tsmfRelTs), true);
    }

    /**
     * @param format the format to receive the stream
     * @param detect `true` to detect the format (only by the service scan, the streams use the format detected)
     * @param relTs the relative stream of TSMF (default: `tsmfRelTs` of the channel)
     * @param notTSMF `true` if the detection has found the stream is not TSMF
     */
    private async _scanServices(
        channel: ChannelItem,
        userReq: common.User,
        format: apid.StreamFormat,
        detect: boolean,
        relTs = channel.tsmfRelTs,
        notTSMF = false
    ): Promise<apid.Service[]> {
        const tsFilter = await this._initTS(userReq, undefined, [this._getCandidate(channel, relTs, format)]);
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
            let tsmf: TSMFStream[] = null;
            let isNotTSMF = notTSMF;

            const timeout = setTimeout(() => tsFilter.close(), 20000);

            probe?.detected.then(detected => {
                if (detected === null || tsFilter.closed) {
                    return;
                }
                // the scan receives the relative streams mixed
                if (detected.tsmf !== null) {
                    tsmf = detected.tsmf;
                    tsFilter.close();
                    return;
                }
                isNotTSMF = isNotTSMF || probe.tsmf;
                // the scan has succeeded in the format
                if (detected.format === format || (network.networkId !== -1 && services !== null)) {
                    return;
                }
                log.info("Tuner: the format of %s/%s is detected as `%s`, scanning again", channel.type, channel.channel, detected.format);
                retryFormat = detected.format;
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

            tsFilter.once("close", async () => {
                tsFilter.removeAllListeners("network");
                tsFilter.removeAllListeners("services");
                clearTimeout(timeout);
                // TSMF is known only by the detection (the data received by the scan is enough in most cases)
                if (probe?.tsmf === true && retryFormat === null && tsmf === null) {
                    const detected = await probe.detected;
                    tsmf = detected?.tsmf || null;
                    isNotTSMF = isNotTSMF || (detected !== null && tsmf === null);
                }
                probe?.end();

                if (tsmf !== null) {
                    // the tuner is kept tuned for a while, the streams of the scans join it
                    resolve(this._scanTSMFServices(channel, userReq, tsmf));
                } else if (retryFormat !== null) {
                    // the tuner is kept tuned for a while, the stream of the scan joins it
                    // (`streamInfo` is defined on the user of each stream)
                    resolve(this._scanServices(channel, { ...userReq, streamSetting: { ...userReq.streamSetting } }, retryFormat, false, relTs, isNotTSMF));
                } else if (network.networkId === -1) {
                    reject(new Error("stream has closed before get network"));
                } else if (services === null) {
                    reject(new Error("stream has closed before get services"));
                } else {
                    // the streams of all the relative streams of TSMF are saved together,
                    // and the scan without the detection (on the tuners only for TS) receives the relative streams detected mixed
                    // (unless no tuners detect any longer, the relative streams detected cannot be received by the remote tuners)
                    const keepsTSMF = relTs === undefined && isNotTSMF === false && channel.streams.some(stream => stream.relTs !== undefined) &&
                        this._getDevicesByType(channel.type, channel.route).some(device => this._detectsFormat(device));
                    if (services.length > 0 && relTs === channel.tsmfRelTs && !keepsTSMF && _.channel.get(channel.type, channel.channel) === channel) {
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

    /**
     * scans all the relative streams of TSMF at the same time
     * (a relative stream may have no services, such as for the engineering)
     */
    private async _scanTSMFServices(channel: ChannelItem, userReq: common.User, streams: TSMFStream[]): Promise<apid.Service[]> {
        log.info(
            "Tuner: the relative streams of TSMF on %s/%s are detected: %s",
            channel.type, channel.channel, streams.map(stream => `${stream.relTs}:${stream.format}(${stream.slots} slots)`).join(", ")
        );

        const results = await Promise.allSettled(streams.map(stream => this._scanServices(
            channel,
            { ...userReq, streamSetting: { ...userReq.streamSetting } },
            stream.format,
            false,
            stream.relTs
        )));

        const services: apid.Service[] = [];
        let lastError: Error = null;
        // the stream of the services scanned (the same as without TSMF), the one of the TSMF header if no services
        const channelStreams = streams.map(({ networkId, streamId, format, relTs, slots }) => ({ networkId, streamId, format, relTs, slots }));
        results.forEach((result, i) => {
            if (result.status === "fulfilled") {
                services.push(...result.value);
                if (result.value.length > 0) {
                    channelStreams[i] = { ...channelStreams[i], networkId: result.value[0].networkId, streamId: result.value[0].streamId };
                }
            } else {
                lastError = result.reason;
                log.warn(
                    "Tuner: the services of the relative stream %d of TSMF on %s/%s are not received [%s]",
                    streams[i].relTs, channel.type, channel.channel, lastError.message
                );
                // the stream received before is kept (the format detected may be wrong if the scan has failed)
                const saved = channel.getStreamByRelTs(streams[i].relTs);
                if (saved !== null) {
                    channelStreams[i] = { networkId: saved.networkId, streamId: saved.streamId, format: saved.format, relTs: saved.relTs, slots: streams[i].slots };
                }
            }
        });
        if (services.length === 0 && lastError !== null) {
            throw lastError;
        }

        if (_.channel.get(channel.type, channel.channel) === channel) {
            channel.setStreams(channelStreams);
        }
        return services;
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
     * detects the format (and the relative streams of TSMF) of the stream by joining the tuner streaming to `user` (does not tune by itself)
     * @returns `null` if the format is not detected: the remote Mirakurun outputs the format by itself,
     * and only the tuners for TLV (MMT) detect, not to add any work to the environments only for TS
     * (`tsmf`: whether the relative streams of TSMF are detected)
     */
    private _startFormatProbe(user: common.User): { detected: Promise<DetectedFormat | null>, tsmf: boolean, end: () => void } | null {
        // the ID of the scan is not unique (the scans run on the tuners at the same time), `streamSetting` is of this scan
        const device = this._devices.find(device => device.users.some(deviceUser => deviceUser.streamSetting === user.streamSetting));
        if (!device || this._detectsFormat(device) === false) {
            return null;
        }

        // TSMF is TS outside, the relative streams are detected by the header
        const relTs = user.streamSetting.channel.tsmfRelTs;
        let tsmf: TSMFStream[] = null;
        const probe = new FormatProbe(relTs ? data => detectTSMFStreamFormat(data, relTs) : data => {
            tsmf = detectTSMFStreams(data, false);
            if (tsmf !== null && tsmf.length === 0) {
                // TSMF but not decided, not to replace the relative streams detected before
                tsmf = null;
                return null;
            }
            return tsmf === null ? detectStreamFormat(data) : "ts";
        });
        const detected = probe.detect(DETECT_TIMEOUT).then(format => {
            probe.end();
            return format === null ? null : { format, tsmf };
        });
        device.startStream({ ...user, id: `${user.id}#format` }, probe).catch(err => {
            log.debug("Tuner: the format detection has failed (%s)", err.message);
            probe.end();
        });
        return { detected, tsmf: !relTs, end: () => probe.end() };
    }

    /**
     * @param candidates the channels (and the relative streams of TSMF) carrying the same stream (default: `streamSetting.channel`)
     */
    private async _initTS(user: common.User, dest?: Writable, candidates?: TunerCandidate[]): Promise<common.StreamFilter | null> {
        const setting = user.streamSetting;

        if (_.config.server.disableEITParsing === true) {
            setting.parseEIT = false;
        }

        candidates = candidates || [this._getCandidate(setting.channel, setting.channel.defaultRelTs)];
        if (dest && user.outputFormat) {
            candidates = candidates.map(candidate => {
                const { devices } = candidate;
                if (candidate.format === "tlv") {
                    // only the tuners can convert TLV to TS
                    return { ...candidate, devices: user.outputFormat === "ts" ? devices.filter(device => !!device.config.tlvToTsDecoder) : devices };
                }
                // the streams of TS cannot output TLV
                return { ...candidate, devices: user.outputFormat === "tlv" ? [] : devices };
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
            // the tuners of the other bonded carriers
            const carriers = picked === null ? null : this._pickCarrierDevices(picked, user.priority);

            if (picked === null || carriers === null) {
                // retry
                tryCount--;
                if (tryCount <= 0) {
                    throw new Error("no available tuners");
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            } else {
                // found
                const { device, channel, candidate } = picked;
                const isTlv = candidate.format === "tlv";
                const { relTs } = candidate;
                setting.channel = channel;
                // only the relative stream detected (`tsmfRelTs` of channels.yml is of the channel, as before)
                setting.tsmfRelTs = relTs !== channel.tsmfRelTs ? relTs : undefined;
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
                        tsmfRelTs: relTs,
                        tsmfCarriers: carriers.length + 1
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
                        tsmfRelTs: relTs
                    });
                }

                Object.defineProperty(user, "streamInfo", {
                    get: () => tsFilter.streamInfo
                });

                try {
                    // the tuners of the carriers are started at once, not to be picked by the other requests while starting the first one
                    await Promise.all([
                        device.startStream(user, tsFilter, setting.channel),
                        ...carriers.map(({ device: carrierDevice, channel: carrierChannel }, i) => carrierDevice.startStream(
                            { ...user, id: `${user.id}#carrier${i + 1}`, streamSetting: { channel: carrierChannel } },
                            new CarrierSink(tsFilter as TLVFilter, i + 1),
                            carrierChannel
                        ))
                    ]);
                    return tsFilter;
                } catch (err) {
                    tsFilter.end();
                    throw err;
                }
            }
        }
    }

    /**
     * the tuners of the other bonded carriers of the channel
     * @returns `[]` if not bonded, `null` if not available
     */
    private _pickCarrierDevices(
        { device, channel, candidate }: { device: TunerDevice, channel: ChannelItem, candidate: TunerCandidate },
        priority: number,
        excluded: Set<TunerDevice> = new Set()
    ): { device: TunerDevice, channel: ChannelItem }[] | null {
        // the TLV of the relative stream of TSMF
        const channels = candidate.relTs && candidate.format === "tlv" ? channel.getBondedChannels() : null;
        if (channels === null || channels.length < 2) {
            return [];
        }

        const used = new Set([device, ...excluded]);
        const picked: { device: TunerDevice, channel: ChannelItem }[] = [];
        for (const carrierChannel of channels) {
            if (carrierChannel === channel) {
                continue;
            }
            const carrier = this._pickTunerDevice([{
                ...this._getCandidate(carrierChannel, candidate.relTs, candidate.format),
                devices: this._getDevicesByType(carrierChannel.type, carrierChannel.route).filter(d => used.has(d) === false)
            }], priority);
            if (carrier === null) {
                return null;
            }
            used.add(carrier.device);
            picked.push(carrier);
        }
        return picked;
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
    ): { device: TunerDevice, channel: ChannelItem, candidate: TunerCandidate } | null {
        // 1. join to existing
        for (const candidate of candidates) {
            for (const device of candidate.devices) {
                if (device.isAvailable === true && device.channel === candidate.channel) {
                    return { device, channel: candidate.channel, candidate };
                }
            }
        }

        // 2. start as new
        for (const candidate of candidates) {
            for (const device of candidate.devices) {
                if (device.isFree === true) {
                    return { device, channel: candidate.channel, candidate };
                }
            }
        }

        // 3. replace existing
        for (const candidate of candidates) {
            for (const device of candidate.devices) {
                if (device.isAvailable === true && device.users.length === 0) {
                    return { device, channel: candidate.channel, candidate };
                }
            }
        }

        // 4. takeover existing
        if (priority >= 0) {
            const targets = candidates.flatMap(candidate => candidate.devices.map(device => ({ device, channel: candidate.channel, candidate })));
            targets.sort((t1, t2) => t1.device.getPriority() - t2.device.getPriority());
            for (const target of targets) {
                if (target.device.isUsing === true && target.device.getPriority() < priority) {
                    return target;
                }
            }
        }

        return null;
    }

    /** the remote Mirakurun outputs the format by itself, only the tuners for TLV (MMT) detect */
    private _detectsFormat(device: TunerDevice): boolean {
        const { types, tlvDecoder, tlvToTsDecoder } = device.config;
        return !device.isRemote && (!!tlvDecoder || !!tlvToTsDecoder || types.some(type => common.tlvChannelTypes.includes(type)));
    }

    private _getCandidates(targets: StreamTarget[]): TunerCandidate[] {
        return targets.map(({ channel, relTs }) => this._getCandidate(channel, relTs));
    }

    /** @param format the format to receive (default: the format of the channel or the relative stream) */
    private _getCandidate(channel: ChannelItem, relTs?: number, format?: apid.StreamFormat): TunerCandidate {
        const receivable = this._getReceivableRelTs(channel, relTs);
        if (receivable !== relTs) {
            relTs = receivable;
            format = undefined;
        }
        let devices = this._getDevicesByType(channel.type, channel.route);
        // the remote Mirakurun outputs the relative stream of its own, only `tsmfRelTs` of the channel is received as before
        if (relTs !== undefined && relTs !== channel.tsmfRelTs) {
            devices = devices.filter(device => !device.isRemote);
        }
        return {
            channel,
            devices,
            relTs,
            format: format || channel.getFormat(relTs)
        };
    }

    /**
     * the relative stream detected is received by the local tuners,
     * the stream of the channel (as before) if there are only the remote tuners (such as the tuners detected have been removed)
     */
    private _getReceivableRelTs(channel: ChannelItem, relTs: number): number {
        if (relTs === undefined || relTs === channel.tsmfRelTs) {
            return relTs;
        }
        return this._getDevicesByType(channel.type, channel.route).some(device => !device.isRemote) ? relTs : channel.tsmfRelTs;
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
