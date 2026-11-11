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
import ChannelItem, { ChannelStream } from "./ChannelItem";
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

/** the stream scanned by the channel scan (`Tuner.scanChannel()`) */
export interface ScannedStream {
    /** the relative stream of TSMF (`undefined` if not TSMF) */
    relTs?: number;
    format: apid.StreamFormat;
    services: apid.Service[];
    /** TSMF of multiple carriers (the TLV is not scanned until all the carriers are known) */
    numberOfCarriers?: number;
    /** the network of the relative stream in the TSMF header */
    networkId?: number;
    /** the services of the relative stream are not received (the scan has failed) */
    failed?: boolean;
    /** the streams of the network by NIT (if collected, only of TS not of TSMF) */
    networkStreams?: common.NetworkStreams;
}

/** the tuners to try a channel by the channel scan, as the type */
export interface ScanAttempt {
    type: apid.ChannelType;
    devices: TunerDevice[];
}

interface ScanOptions {
    /** detects the format and the relative streams of TSMF on any local tuner (only by the channel scan) */
    anyTuner?: boolean;
    /** the tuners to receive (only by the channel scan) */
    devices?: TunerDevice[];
    /** waits for the streams of the network by all the sections of NIT (only by the channel scan) */
    networkStreams?: boolean;
    /** collects the streams scanned */
    streams?: ScannedStream[];
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
        // the channel is received as the stream of the channel (`tsmfRelTs`, the carriers of it are bonded),
        // the candidates never received (such as the carriers more than the tuners) are not waited for
        const targets = (Array.isArray(channels) ? channels : [channels]).map(target => target instanceof ChannelItem ? { channel: target, relTs: target.tsmfRelTs } : target);
        const candidates = this._getCandidates(targets).filter(candidate => candidate.devices.length > 0 && this._hasCarrierDevices(candidate));
        if (candidates.length === 0) {
            log.error("readyForJob: no tuners for channel %s", targets.map(({ channel }) => `${channel.type}/${channel.channel}`).join(", "));
            return null;
        }

        while (true) {
            // the bonded carriers need the tuners too
            const { picked, carriers } = this._pickTunerDeviceWithCarriers(
                candidates.map(candidate => ({
                    ...candidate,
                    devices: candidate.devices.filter(device => !this._readyForJobPickedDeviceSet.has(device))
                })),
                -1,
                this._readyForJobPickedDeviceSet
            );
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

    canReceiveTsmfCarriers(channel: ChannelItem, count: number): boolean {
        return this._getDevicesByType(channel.type, channel.route).filter(device => !device.isRemote).length >= count;
    }

    typeExists(type: apid.ChannelType, route?: apid.ChannelRoute): boolean {
        return this._getDevicesByType(type, route).length > 0;
    }

    /**
     * only the remote tuners receive the channel of the type, and every remote Mirakurun outputs its relative streams of TSMF
     * (detected by itself, or `tsmfRelTs` of its channels.yml even of 4.3.0 or before), not filtered by `tsmfRelTs` locally
     */
    async receivesRelTsByRemote(type: apid.ChannelType, route: apid.ChannelRoute, channel: string): Promise<boolean> {
        const devices = this._getDevicesByType(type, route);
        if (devices.length === 0 || devices.some(device => !device.isRemote)) {
            return false;
        }
        await Promise.all(devices.map(device => device.checkRemoteRelTs()));
        const hosts = new Map<string, TunerDevice[]>();
        for (const device of devices) {
            const host = `${device.config.remoteMirakurunHost}:${device.config.remoteMirakurunPort || 40772}`;
            hosts.set(host, [...(hosts.get(host) || []), device]);
        }
        for (const hostDevices of hosts.values()) {
            try {
                const remoteChannel = await hostDevices[0].getRemoteChannel(type, channel);
                // detected by the remote Mirakurun, received by the tuners supporting it
                const detected = hostDevices.every(device => device.supportsRemoteRelTs) && (remoteChannel.services || []).some(service => service.tsmfRelTs !== undefined);
                if (remoteChannel.tsmfRelTs === undefined && !detected) {
                    return false;
                }
            } catch (err) {
                return false;
            }
        }
        return true;
    }

    /**
     * the output format of the stream request
     * @param targets the channels (and the relative streams of TSMF) to receive the stream
     * @returns `null` if the format is unavailable
     */
    getOutputFormat(targets: StreamTarget[], requested?: apid.StreamFormat): apid.StreamFormat | null {
        const tlvTargets = targets.filter(({ channel, relTs }) => this._getCandidate(channel, relTs).format === "tlv");
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
        // the relative stream detected specified (such as the carriers not found)
        if (relTs !== channel.tsmfRelTs && this._getCandidate(channel, relTs).devices.length === 0) {
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
        const userReq = this._getScanUser(channel, user);

        // only the remote tuners: the relative streams of TSMF detected by the remote Mirakurun
        const remoteStreams = await this._getRemoteTSMFStreams(channel);
        if (remoteStreams !== null) {
            return this._scanTSMFServices(channel, userReq, remoteStreams, undefined, true);
        }
        return this._scanServices(channel, userReq, channel.getFormat(channel.tsmfRelTs), true);
    }

    /**
     * scans the services of each stream (each relative stream of TSMF) of a channel for the channel scan (the channel is not registered),
     * the format and the relative streams of TSMF are detected on any local tuner
     * @param networkStreams collects the streams of the network by all the sections of NIT (`ScannedStream.networkStreams`)
     */
    async scanChannel(channel: ChannelItem, user: Partial<common.User> = {}, devices?: TunerDevice[], networkStreams = false): Promise<ScannedStream[]> {
        const streams: ScannedStream[] = [];
        const userReq = this._getScanUser(channel, user);
        if (networkStreams) {
            userReq.streamSetting.parseNetworkStreams = true;
        }
        // the remote tuners: the relative streams of TSMF detected by the remote Mirakurun (its stream as received is TS)
        const remoteStreams = devices?.length > 0 && devices.every(device => device.isRemote) ? await this._getRemoteTSMFStreams(channel, devices) : null;
        if (remoteStreams !== null) {
            await this._scanTSMFServices(channel, userReq, remoteStreams, streams, true, devices);
            return streams;
        }
        await this._scanServices(channel, userReq, channel.getFormat(channel.tsmfRelTs), true, channel.tsmfRelTs, false, { anyTuner: true, streams, devices, networkStreams });
        return streams;
    }

    /** the channels of the channel config files of dvbv5-zap of the tuners of the type for the route (in the order of the files) */
    async getDvbChannelNames(route: apid.ChannelRoute, type: apid.ChannelType): Promise<string[]> {
        const names = new Set<string>();
        for (const device of this._getDevicesByType(type, route)) {
            const deviceNames = await device.getDvbChannelNames(route).catch(err => {
                log.warn("Tuner: the channel config file of TunerDevice#%d is not read (%s)", device.index, err.message);
                return null;
            });
            deviceNames?.forEach(name => names.add(name));
        }
        return [...names];
    }

    /**
     * the tuners to try a channel of the route by the channel scan, covering all the tuners of the route (in the order of `types`):
     * the local tuners of the same types are tried once by the first of the types (they receive the same),
     * the remote tuners of the same remote Mirakurun by each of the types (the remote Mirakurun receives only the channel of the type configured)
     */
    getScanAttempts(route: apid.ChannelRoute, types: apid.ChannelType[] = common.channelTypes): ScanAttempt[] {
        const attempts: ScanAttempt[] = [];
        const groups = new Map<string, ScanAttempt>();
        for (const device of this._devices) {
            const deviceTypes = types.filter(type => device.config.types.includes(type));
            if (deviceTypes.length === 0 || (device.config.routes && device.config.routes.includes(route) === false)) {
                continue;
            }
            // the remote tuners of the same remote Mirakurun and the type receive the same too
            const keys = device.isRemote ?
                deviceTypes.map(type => `${device.config.remoteMirakurunHost}:${device.config.remoteMirakurunPort || 40772}/${type}`) :
                [deviceTypes.join(",")];
            for (let i = 0; i < keys.length; i++) {
                const group = groups.get(keys[i]);
                if (group) {
                    group.devices.push(device);
                } else {
                    const attempt = { type: deviceTypes[i], devices: [device] };
                    groups.set(keys[i], attempt);
                    attempts.push(attempt);
                }
            }
        }
        // the types in the order (stable)
        return attempts.sort((a, b) => types.indexOf(a.type) - types.indexOf(b.type));
    }

    private _getScanUser(channel: ChannelItem, user: Partial<common.User>): common.User {
        return {
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
    }

    /**
     * the relative streams of TSMF of the services of the channel of the remote Mirakurun (`tsmfRelTs` and `format` of Channel.services),
     * only for the channel received only by the remote tuners (the local tuners detect, such as the carriers to bond)
     * @returns `null` if not TSMF, or not known by the remote Mirakurun (such as 4.3.0 or before)
     */
    /** @param devices the tuners to receive (default: the tuners of the channel) */
    private async _getRemoteTSMFStreams(channel: ChannelItem, devices = this._getDevicesByType(channel.type, channel.route)): Promise<TSMFStream[] | null> {
        if (channel.tsmfRelTs !== undefined || devices.length === 0 || devices.some(device => !device.isRemote)) {
            return null;
        }
        // the relative streams detected by the remote Mirakurun before (not to replace them by the stream as received)
        const getSaved = (): TSMFStream[] | null => {
            const saved = channel.streams.filter(stream => stream.remote === true && stream.relTs !== undefined);
            return saved.length > 0 ? saved.map(stream => ({
                relTs: stream.relTs,
                slots: 0,
                format: stream.format,
                streamId: stream.streamId,
                networkId: stream.networkId
            })) : null;
        };

        // the remote Mirakurun of 4.3.0 or before does not output the relative stream detected (each host once)
        await Promise.all(devices.map(device => device.checkRemoteRelTs()));
        const hosts = new Map<string, TunerDevice>();
        for (const device of devices.filter(item => item.supportsRemoteRelTs)) {
            const host = `${device.config.remoteMirakurunHost}:${device.config.remoteMirakurunPort || 40772}`;
            if (!hosts.has(host)) {
                hosts.set(host, device);
            }
        }
        if (hosts.size === 0) {
            // not known yet (such as failed to check): as before
            return devices.every(device => device.isRemoteRelTsChecked) ? null : getSaved();
        }

        // the first remote Mirakurun detecting the relative streams
        let unknown = false;
        for (const device of hosts.values()) {
            let services: apid.Service[];
            try {
                services = (await device.getRemoteChannel(channel.type, channel.channel)).services || [];
            } catch (err) {
                log.warn("Tuner: failed to get the channel %s/%s of the remote Mirakurun [%s]", channel.type, channel.channel, err.message);
                unknown = true;
                continue;
            }
            // no services yet (such as scanning by the remote Mirakurun)
            if (services.length === 0) {
                unknown = true;
                continue;
            }

            const streams = new Map<number, TSMFStream>();
            for (const service of services) {
                if (!Number.isInteger(service.tsmfRelTs) || (service.format !== "ts" && service.format !== "tlv") || streams.has(service.tsmfRelTs)) {
                    continue;
                }
                streams.set(service.tsmfRelTs, {
                    relTs: service.tsmfRelTs,
                    // not known by the services
                    slots: 0,
                    format: service.format,
                    streamId: service.streamId,
                    networkId: service.networkId
                });
            }
            if (streams.size > 0) {
                // the relative streams reported are requested again (even if refused before, such as while scanning by the remote Mirakurun)
                for (const item of devices.filter(other => other.config.remoteMirakurunHost === device.config.remoteMirakurunHost &&
                    (other.config.remoteMirakurunPort || 40772) === (device.config.remoteMirakurunPort || 40772))) {
                    for (const relTs of streams.keys()) {
                        item.clearRemoteRelTsRefused(channel, relTs);
                    }
                }
                return [...streams.values()].sort((a, b) => a.relTs - b.relTs);
            }
        }
        if (unknown) {
            return getSaved();
        }

        // the remote Mirakurun does not detect TSMF any longer (such as `tsmfRelTs` of its channels.yml)
        if (channel.streams.some(stream => stream.remote === true)) {
            log.info("Tuner: the relative streams of TSMF on %s/%s are not detected by the remote Mirakurun any longer", channel.type, channel.channel);
            channel.setStreams([]);
        }
        return null;
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
        notTSMF = false,
        options: ScanOptions = {}
    ): Promise<apid.Service[]> {
        const candidate = this._getCandidate(channel, relTs, format);
        if (options.devices) {
            candidate.devices = candidate.devices.filter(device => options.devices.includes(device));
        }
        const tsFilter = await this._initTS(userReq, undefined, [candidate]);
        // the format is detected by the data of the same tuner, the scan does not wait for it
        const probe = detect ? this._startFormatProbe(userReq, options.anyTuner === true, candidate.format) : null;
        return new Promise<apid.Service[]>((resolve, reject) => {
            let network = {
                networkId: -1,
                areaCode: -1,
                remoteControlKeyId: -1
            };
            let services: apid.Service[] = null;
            let networkStreams: common.NetworkStreams = null;
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
                if (detected.format === candidate.format || (network.networkId !== -1 && services !== null)) {
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
                }),
                // NIT of TS (until the timeout, the scan succeeds without the streams of the network)
                ...(options.networkStreams === true && candidate.format === "ts" ? [new Promise<void>(resolve => {
                    tsFilter.once("networkStreams", _networkStreams => {
                        networkStreams = _networkStreams;
                        resolve();
                    });
                })] : [])
            ]).then(() => tsFilter.close());

            tsFilter.once("close", async () => {
                tsFilter.removeAllListeners("network");
                tsFilter.removeAllListeners("services");
                tsFilter.removeAllListeners("networkStreams");
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
                    resolve(this._scanTSMFServices(channel, userReq, tsmf, options.streams, false, options.devices));
                } else if (retryFormat !== null) {
                    // the tuner is kept tuned for a while, the stream of the scan joins it
                    // (`streamInfo` is defined on the user of each stream)
                    resolve(this._scanServices(channel, { ...userReq, streamSetting: { ...userReq.streamSetting } }, retryFormat, false, relTs, isNotTSMF, options));
                } else if (network.networkId === -1) {
                    reject(new Error("stream has closed before get network"));
                } else if (services === null) {
                    reject(new Error("stream has closed before get services"));
                } else {
                    // the streams of all the relative streams of TSMF are saved together,
                    // and the scan without the detection (on the remote tuners) receives the relative streams detected mixed
                    // (unless no local tuners detect any longer, the relative streams detected cannot be received by the remote tuners)
                    const keepsTSMF = relTs === undefined && isNotTSMF === false && channel.streams.some(stream => stream.relTs !== undefined) &&
                        this._getDevicesByType(channel.type, channel.route).some(device => !device.isRemote);
                    if (services.length > 0 && relTs === channel.tsmfRelTs && !keepsTSMF && _.channel.get(channel.type, channel.channel) === channel) {
                        // the format received (the format of the remote Mirakurun with only the remote tuners)
                        channel.setStream(services[0].networkId, services[0].streamId, candidate.format);
                    }
                    if (network.remoteControlKeyId !== -1) {
                        services.forEach(service => {
                            service.remoteControlKeyId = network.remoteControlKeyId;
                        });
                    }

                    options.streams?.push({ relTs, format: candidate.format, services, ...(networkStreams !== null && { networkStreams }) });
                    resolve(services);
                }
            });
        });
    }

    /**
     * scans all the relative streams of TSMF at the same time
     * (a relative stream may have no services, such as for the engineering)
     */
    /**
     * @param collect collects the streams scanned (for the channel scan)
     * @param remote the relative streams detected by the remote Mirakurun (the remote tuners receive them one by one)
     * @param devices the tuners to receive (only by the channel scan)
     */
    private async _scanTSMFServices(
        channel: ChannelItem,
        userReq: common.User,
        streams: TSMFStream[],
        collect?: ScannedStream[],
        remote = false,
        devices?: TunerDevice[]
    ): Promise<apid.Service[]> {
        log.info(
            "Tuner: the relative streams of TSMF on %s/%s are detected: %s",
            channel.type, channel.channel, streams.map(stream => `${stream.relTs}:${stream.format}(${stream.slots} slots)`).join(", ")
        );

        let scanStreams = streams;
        let carriersCompleted = false;
        // the stream of the services scanned (the same as without TSMF), the one of the TSMF header if no services
        // the stream as received of the remote Mirakurun is TS (TSMF)
        let channelStreams: ChannelStream[] = streams.map(stream => ({ ...stream, ...(remote && { remote: true }) }));
        const discovery = streams.find(stream => stream.numberOfCarriers > 1 && stream.format === "tlv");
        if (discovery) {
            // the IDs of the header associate the carriers (`tsmfNetworkId` / `tsmfStreamId`, the IDs of the services may differ),
            // `networkId` / `streamId` of the services scanned are kept until scanned again (as received before if the scan fails)
            channelStreams = streams.map(stream => {
                const saved = channel.getStreamByRelTs(stream.relTs);
                const sameStream = saved?.tsmfNetworkId === stream.networkId && saved?.tsmfStreamId === stream.streamId;
                return {
                    ...stream,
                    ...(sameStream && { networkId: saved.networkId, streamId: saved.streamId }),
                    tsmfNetworkId: stream.networkId,
                    tsmfStreamId: stream.streamId
                };
            });
            const discoveryChanged = streams.some(stream => {
                const saved = channel.getStreamByRelTs(stream.relTs);
                return !saved || saved.groupId !== stream.groupId || saved.numberOfCarriers !== stream.numberOfCarriers ||
                    saved.carrierSequence !== stream.carrierSequence || saved.tsmfNetworkId !== stream.networkId || saved.tsmfStreamId !== stream.streamId;
            });
            if (_.channel.get(channel.type, channel.channel) === channel) {
                // to find the other carriers (copied, the streams are updated by the scan)
                channel.setStreams([...channelStreams]);
            }
            const canReceive = this.canReceiveTsmfCarriers(channel, discovery.numberOfCarriers);
            if (!canReceive || !channel.hasAllCarriers(discovery)) {
                log.info(
                    "Tuner: the TLV of the relative stream %d on %s/%s is not scanned until all the %d carriers of the group %d are found (%s)",
                    discovery.relTs, channel.type, channel.channel, discovery.numberOfCarriers, discovery.groupId,
                    canReceive ? `carriers found: ${(channel.getBondedChannels() || []).length}, or carrier_sequence is invalid` : "not enough local tuners"
                );
                // TS services on a shared carrier do not require the other carriers.
                scanStreams = streams.filter(stream => stream.format === "ts");
            } else {
                carriersCompleted = discoveryChanged;
            }
        } else if (!remote && channel.streams.some(stream => stream.remote === true) && _.channel.get(channel.type, channel.channel) === channel) {
            // the relative streams detected by the local tuners are received by them (not as detected by the remote Mirakurun)
            channel.setStreams([...channelStreams]);
        }

        const scan = (stream: TSMFStream): Promise<apid.Service[]> => this._scanServices(
            channel,
            { ...userReq, streamSetting: { ...userReq.streamSetting } },
            stream.format,
            false,
            stream.relTs,
            false,
            { devices }
        );
        // the remote tuners receive a relative stream each (not to wait for the tuners until the timeout)
        const results: PromiseSettledResult<apid.Service[]>[] = [];
        if (remote) {
            for (const stream of scanStreams) {
                results.push(...await Promise.allSettled([scan(stream)]));
            }
        } else {
            results.push(...await Promise.allSettled(scanStreams.map(scan)));
        }

        const services: apid.Service[] = [];
        const streamServices: apid.Service[][] = streams.map(() => []);
        const failed: boolean[] = streams.map(() => false);
        let lastError: Error = null;
        results.forEach((result, index) => {
            const i = scanStreams === streams ? index : streams.indexOf(scanStreams[index]);
            if (result.status === "fulfilled") {
                services.push(...result.value);
                streamServices[i] = result.value;
                if (result.value.length > 0) {
                    channelStreams[i] = { ...channelStreams[i], networkId: result.value[0].networkId, streamId: result.value[0].streamId };
                }
            } else {
                failed[i] = true;
                lastError = result.reason;
                log.warn(
                    "Tuner: the services of the relative stream %d of TSMF on %s/%s are not received [%s]",
                    streams[i].relTs, channel.type, channel.channel, lastError.message
                );
                // the stream received before is kept (the format detected may be wrong if the scan has failed)
                const saved = channel.getStreamByRelTs(streams[i].relTs);
                if (saved !== null) {
                    channelStreams[i] = { ...channelStreams[i], networkId: saved.networkId, streamId: saved.streamId, format: saved.format };
                }
            }
        });
        // the other carriers scan the TLV only if it is not scanned by this (its services are added by any carrier)
        const tlvScanned = scanStreams.some((stream, index) => stream.format === "tlv" && results[index].status === "fulfilled" &&
            (results[index] as PromiseFulfilledResult<apid.Service[]>).value.length > 0);
        if (carriersCompleted && !tlvScanned) {
            for (const carrier of channel.getBondedChannels()) {
                if (carrier !== channel) {
                    _.service.queueDiscoveredTsmfScan(carrier);
                }
            }
        }

        collect?.push(...streams.map((stream, i) => ({
            relTs: stream.relTs,
            format: stream.format,
            services: streamServices[i],
            networkId: stream.networkId,
            ...(stream.numberOfCarriers > 1 && { numberOfCarriers: stream.numberOfCarriers }),
            ...(failed[i] && { failed: true })
        })));

        // the channel scan adds the carriers bonded without the services (the TLV is scanned when all the carriers are found)
        if (services.length === 0 && lastError !== null && !collect?.some(stream => stream.format === "tlv" && stream.numberOfCarriers > 1)) {
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
                // (the tuner of no routes would never be used without any notice)
                (Array.isArray(tuner.routes) === false || tuner.routes.length === 0 || tuner.routes.some(route => common.channelRoutes.includes(route) === false))
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

        // whether the remote Mirakurun outputs the relative stream of TSMF detected (not used for it until checked)
        for (const device of this._devices) {
            if (device.isRemote) {
                device.checkRemoteRelTs();
            }
        }

        return this;
    }

    /**
     * detects the format (and the relative streams of TSMF) of the stream by joining the tuner streaming to `user` (does not tune by itself)
     * @returns `null` if the format is not detected: the remote Mirakurun outputs the format by itself
     * (`tsmf`: whether the relative streams of TSMF are detected)
     * @param anyTuner `true` to detect the format on any local tuner (only by the channel scan)
     * @param format the format received (the tuners only for TS detect only the relative streams of TSMF by the service scan,
     * reading the head of the stream once by each scan: the stream without TSMF is of this format)
     */
    private _startFormatProbe(
        user: common.User,
        anyTuner = false,
        format: apid.StreamFormat = "ts"
    ): { detected: Promise<DetectedFormat | null>, tsmf: boolean, end: () => void } | null {
        // the ID of the scan is not unique (the scans run on the tuners at the same time), `streamSetting` is of this scan
        const device = this._devices.find(device => device.users.some(deviceUser => deviceUser.streamSetting === user.streamSetting));
        if (!device || device.isRemote) {
            return null;
        }

        // TSMF is TS outside, the relative streams are detected by the header
        const relTs = user.streamSetting.channel.tsmfRelTs;
        const tsmfOnly = !anyTuner && this._detectsFormat(device) === false;
        if (relTs && tsmfOnly) {
            return null;
        }
        let tsmf: TSMFStream[] = null;
        const probe = new FormatProbe(relTs ? data => detectTSMFStreamFormat(data, relTs) : data => {
            tsmf = detectTSMFStreams(data);
            if (tsmf !== null && tsmf.length === 0) {
                // TSMF but not decided, not to replace the relative streams detected before
                tsmf = null;
                return null;
            }
            if (tsmf !== null) {
                return "ts";
            }
            return tsmfOnly ? format : detectStreamFormat(data);
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
            // the relative stream detected is received by the local tuners if any (the remote Mirakurun may not have detected it),
            // the programs of the remote Mirakurun are used if only the remote tuners (as before, regardless of the relative stream)
            const remoteResult = await this._useRemoteData(user, candidates.flatMap(candidate => {
                if (candidate.relTs === candidate.channel.tsmfRelTs) {
                    return candidate.devices;
                }
                const local = candidate.devices.filter(device => !device.isRemote);
                return local.length > 0 ? local : this._getDevicesByType(candidate.channel.type, candidate.channel.route).filter(device => device.isRemote);
            }));
            if (remoteResult) {
                return null;
            }
        }

        while (tryCount > 0) {
            // the tuners of the other bonded carriers (the remote tuners refused the relative stream detected are not used)
            const { picked, carriers } = this._pickTunerDeviceWithCarriers(candidates.map(candidate => ({
                ...candidate,
                devices: candidate.devices.filter(device => !this._isDetectedByRemote(candidate, device) || device.canReceiveRemoteRelTs(candidate.channel, candidate.relTs))
            })), user.priority);

            // the remote Mirakurun may not have detected the relative stream (refused with an empty stream), picked again after checked
            if (picked !== null && this._isDetectedByRemote(picked.candidate, picked.device) && !picked.device.isRemoteChannelRelTsChecked(picked.channel, picked.candidate.relTs)) {
                await picked.device.checkRemoteChannelRelTs(picked.channel, picked.candidate.relTs);
                continue;
            }

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
                setting.format = candidate.format;
                // the remote Mirakurun outputs the relative stream detected (extracted, and bonded)
                const filterRelTs = device.isRemote && setting.tsmfRelTs !== undefined ? undefined : relTs;
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
                        tsmfRelTs: filterRelTs,
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
                        parseNetworkStreams: setting.parseNetworkStreams,
                        tsmfRelTs: filterRelTs
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
     * the tuner and the tuners of the other bonded carriers,
     * by the remote tuners (bonding the TLV of the relative stream detected by themselves) if the local tuners of the carriers are not available
     * @returns `carriers` is `null` if not available
     */
    private _pickTunerDeviceWithCarriers(
        candidates: TunerCandidate[],
        priority: number,
        excluded?: Set<TunerDevice>
    ): { picked: { device: TunerDevice, channel: ChannelItem, candidate: TunerCandidate } | null, carriers: { device: TunerDevice, channel: ChannelItem }[] | null } {
        // the remote tuners for the relative stream detected come after the local tuners (taking over, and of the carriers),
        // the remote Mirakurun may not have detected it
        const isDetectedByRemote = (candidate: TunerCandidate, device: TunerDevice): boolean => this._isDetectedByRemote(candidate, device);
        const picked = this._pickTunerDevice(candidates.map(candidate => ({
            ...candidate,
            devices: candidate.devices.filter(device => !isDetectedByRemote(candidate, device))
        })), priority);
        const carriers = picked === null ? null : this._pickCarrierDevices(picked, priority, excluded);
        if (picked !== null && carriers !== null) {
            return { picked, carriers };
        }
        const remote = this._pickTunerDevice(candidates.map(candidate => ({
            ...candidate,
            devices: candidate.devices.filter(device => isDetectedByRemote(candidate, device))
        })), priority);
        return remote === null ? { picked, carriers: null } : { picked: remote, carriers: this._pickCarrierDevices(remote, priority, excluded) };
    }

    /** whether the tuners exist for all the bonded carriers of the candidate (in use or not) */
    private _hasCarrierDevices(candidate: TunerCandidate): boolean {
        const channels = candidate.relTs && candidate.format === "tlv" ? candidate.channel.getBondedChannels() : null;
        // the remote Mirakurun bonds the carriers of the relative stream detected by itself
        if (channels === null || channels.length < 2 || candidate.devices.some(device => this._isDetectedByRemote(candidate, device))) {
            return true;
        }
        const devices = new Set<TunerDevice>();
        for (const channel of channels) {
            const carrierDevices = channel === candidate.channel ? candidate.devices : this._getCandidate(channel, candidate.relTs, candidate.format).devices;
            if (carrierDevices.length === 0) {
                return false;
            }
            carrierDevices.forEach(device => devices.add(device));
        }
        return devices.size >= channels.length;
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
        // the relative stream detected is requested from the remote Mirakurun (bonds the carriers by itself, not of `tsmfRelTs` of channels.yml)
        const detected = this._getRemoteRelTs(candidate) !== undefined;
        // the TLV of the relative stream of TSMF
        const channels = candidate.relTs && candidate.format === "tlv" && !(device.isRemote && detected) ? channel.getBondedChannels() : null;
        if (channels === null || channels.length < 2) {
            return [];
        }

        const used = new Set([device, ...excluded]);
        const picked: { device: TunerDevice, channel: ChannelItem }[] = [];
        for (const carrierChannel of channels) {
            if (carrierChannel === channel) {
                continue;
            }
            // the tuners of the candidate (the carriers of the relative stream detected by the local tuners, as before)
            const carrierCandidate = this._getCandidate(carrierChannel, candidate.relTs, candidate.format);
            const carrier = this._pickTunerDevice([{
                ...carrierCandidate,
                devices: carrierCandidate.devices.filter(d => !(d.isRemote && detected) && used.has(d) === false)
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
        // 1. join to existing (the remote tuner outputs a relative stream of TSMF)
        for (const candidate of candidates) {
            for (const device of candidate.devices) {
                if (device.isAvailable === true && device.channel === candidate.channel &&
                    (!device.isRemote || (device.remoteRelTs === this._getRemoteRelTs(candidate) && device.remoteFormat === candidate.format))) {
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

    /** the remote Mirakurun outputs the format by itself, only the tuners for TLV (MMT) detect the format (TS / TLV) */
    private _detectsFormat(device: TunerDevice): boolean {
        return !device.isRemote && common.isTlvTuner(device.config);
    }

    private _getCandidates(targets: StreamTarget[]): TunerCandidate[] {
        return targets.map(({ channel, relTs }) => this._getCandidate(channel, relTs));
    }

    /** @param format the format to receive (default: the format of the channel or the relative stream) */
    private _getCandidate(channel: ChannelItem, relTs?: number, format?: apid.StreamFormat): TunerCandidate {
        let devices = this._getDevicesByType(channel.type, channel.route);
        // the relative stream detected: the remote tuners request it by `tsmfRelTs` of the channel stream
        // (the remote Mirakurun of 4.3.0 or before ignores it, and outputs the stream of the channel)
        if (relTs !== undefined && relTs !== channel.tsmfRelTs) {
            // the local tuners come first, and the TLV of the carriers discovered is bonded only if all the carriers are found (not as a single carrier)
            // the remote Mirakurun of 4.3.0 or before outputs the stream of the channel (not the relative stream detected)
            const remote = devices.filter(device => device.isRemote && device.canReceiveRemoteRelTs(channel, relTs));
            devices = this._canReceiveDetectedCarriers(channel, relTs) ? [...devices.filter(device => !device.isRemote), ...remote] : remote;
        } else if (
            (channel.getFormat(relTs) !== channel.remoteFormat || channel.streams.some(stream => stream.remote === true)) &&
            (format === undefined || format === channel.getFormat(relTs))
        ) {
            // the stream of the remote Mirakurun is not the stream as received of TSMF detected by the local tuners,
            // and the local tuners detect TSMF detected by the remote Mirakurun by themselves
            const local = devices.filter(device => !device.isRemote);
            if (local.length > 0) {
                devices = local;
            } else {
                format = channel.remoteFormat;
            }
        }
        return {
            channel,
            devices,
            relTs,
            format: format || channel.getFormat(relTs)
        };
    }

    /** the remote tuner requests the relative stream detected of the candidate (the remote Mirakurun outputs it) */
    private _isDetectedByRemote(candidate: TunerCandidate, device: TunerDevice): boolean {
        return device.isRemote && this._getRemoteRelTs(candidate) !== undefined;
    }

    /** the relative stream of TSMF the remote Mirakurun outputs for the candidate (`undefined`: the stream of the channel) */
    private _getRemoteRelTs(candidate: TunerCandidate): number {
        return candidate.relTs !== candidate.channel.tsmfRelTs ? candidate.relTs : undefined;
    }

    /** the TLV of the relative stream detected of the multiple carriers needs all the carriers of the group and the local tuners for them */
    private _canReceiveDetectedCarriers(channel: ChannelItem, relTs: number): boolean {
        const stream = channel.getStreamByRelTs(relTs);
        // the TLV detected by the remote Mirakurun (the carriers are not known) is received by the remote tuners until the local tuners detect it
        if (stream?.remote === true && stream.format === "tlv") {
            return false;
        }
        if (stream === null || stream.format !== "tlv" || !(stream.numberOfCarriers > 1)) {
            return true;
        }
        return this.canReceiveTsmfCarriers(channel, stream.numberOfCarriers) && channel.hasAllCarriers(stream);
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
