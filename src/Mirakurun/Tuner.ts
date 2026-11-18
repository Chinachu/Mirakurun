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
import { setTimeout as delay } from "timers/promises";
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
const REMOTE_READY_LOOKUP_FAILURE_LIMIT = 3;

/** nullは出力確認の失敗、undefinedは未設定です。未照会の候補は確保前に確認します。 */
type RemoteChannelRelTs = (device: TunerDevice, channel: ChannelItem) => number | undefined | null;
type RemoteChannelStates = Map<TunerDevice, Map<ChannelItem, number | undefined | null>>;
type RemoteChannelFailures = Map<TunerDevice, Set<ChannelItem>>;
interface RemoteChannelQuery { promise: Promise<apid.Channel>; retryable: boolean; reported: Set<string>; checkedAt?: number; expired?: boolean; error?: unknown; }
type RemoteChannelQueries = Map<string, RemoteChannelQuery>;

/** 同じ要求の同じ障害だけを抑制し、接続先・チャンネルや障害の種類が変われば記録する。 */
function reportRemoteChannelFailure(reported: Set<string> | undefined, error: unknown): boolean {
    if (!reported) { return true; }
    const detail = error as { code?: unknown; statusCode?: unknown; status?: unknown };
    const signature = JSON.stringify([detail?.code ?? (error instanceof Error ? error.name : typeof error),
        Number(detail?.statusCode ?? detail?.status)]);
    if (reported.has(signature)) { return false; }
    reported.add(signature);
    return true;
}

/** 通信は要求が所有し、同じ接続先の照会結果だけをその要求の候補間で共有する。 */
function remoteChannelQuery(device: TunerDevice, channel: ChannelItem, queries: RemoteChannelQueries, signal?: AbortSignal): RemoteChannelQuery {
    const key = remoteChannelLookupKey(device, channel);
    const previous = queries.get(key);
    if (previous && !previous.expired) { return previous; }
    const query: RemoteChannelQuery = { retryable: false, reported: previous?.reported ?? new Set(),
        promise: device.getRemoteChannel(channel.type, channel.channel,
            signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000))
            .then(remote => { query.checkedAt = Date.now(); return remote; })
            .catch(error => { query.error = error; query.retryable = isRetryableRemoteLookupError(error); throw error; })
    };
    queries.set(key, query);
    return query;
}

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

/** 確認不能と固定の不適合を分ける。タイムアウト・通信失敗・5xxは準備待ちで再確認する。 */
function isRetryableRemoteLookupError(error: unknown): boolean {
    if ((error as { code?: string })?.code === "ERR_REMOTE_CHANNEL_RELTS_INVALID") { return false; }
    const status = Number((error as { statusCode?: unknown })?.statusCode ?? (error as { status?: unknown })?.status);
    return !Number.isInteger(status) || status < 400 || status >= 500 || status === 408 || status === 429;
}

/** 同じGETでも、通信方式・接続先・認証・チャンネルが違えば結果を共有しない。キーはログへ出さない。 */
function remoteChannelLookupKey(device: TunerDevice, channel: Pick<ChannelItem, "type" | "channel">): string {
    // この版のremote clientはHTTP・認証なし。実際のクライアントが使用する接続情報だけで区別する。
    const config = device.config;
    const host = String(config.remoteMirakurunHost);
    // DNS名以外は大文字小文字も含めてそのまま区別し、未知の接続表記を推測で統合しない。
    const normalizedHost = /^[a-z\d.-]+$/i.test(host) ? host.toLowerCase() : host;
    return JSON.stringify(["http:", normalizedHost,
        config.remoteMirakurunPort || 40772, "", channel.type, String(channel.channel)]);
}

/** a channel and the relative stream of TSMF to receive */
export interface StreamTarget {
    channel: ChannelItem;
    /** the relative stream of TSMF */
    relTs?: number;
}

interface TunerCandidate extends StreamTarget {
    /** 結合用の未展開TSMFを受け取る。 */
    rawTsmf?: boolean;
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
    async readyForJob(channels: ChannelItem | (ChannelItem | StreamTarget)[], signal?: AbortSignal): Promise<ChannelItem | null> {
        signal?.throwIfAborted();

        // 未照会のリモートを展開済みと扱わず、確保時と同じ既定出力で搬送波数を判定する。
        const targets = (Array.isArray(channels) ? channels : [channels]).map(target => target instanceof ChannelItem ? { channel: target, relTs: target.tsmfRelTs } : target);
        const remoteChannels: RemoteChannelStates = new Map();
        const remoteQueries: RemoteChannelQueries = new Map();
        const rawFailureReports = new Map<TunerDevice, Set<string>>();
        const retryableLookups: RemoteChannelFailures = new Map();
        let reportedWaiting = false;
        let transientFailures = 0;
        const remoteChannelRelTs: RemoteChannelRelTs = (device, channel) => remoteChannels.get(device)?.get(channel);
        while (true) {
            signal?.throwIfAborted();

            // 直前に除外されたpeerも、10秒の失敗cacheが切れたら候補へ戻す。
            const candidates = this._getCandidates(targets).filter(candidate => candidate.devices.length > 0);
            const viable = candidates.filter(candidate => this._hasCarrierDevices(candidate, remoteChannelRelTs));
            // the bonded carriers need the tuners too
            const { picked, carriers } = this._pickTunerDeviceWithCarriers(
                viable.map(candidate => ({
                    ...candidate,
                    devices: candidate.devices.filter(device => !this._readyForJobPickedDeviceSet.has(device))
                })),
                -1,
                this._readyForJobPickedDeviceSet,
                remoteChannelRelTs
            );
            if (picked !== null && this._isDetectedByRemote(picked.candidate, picked.device) && !picked.device.isRemoteChannelRelTsChecked(picked.channel, picked.candidate.relTs!)) {
                await this._checkRemoteRelativeForRequest(picked.device, picked.channel, picked.candidate.relTs!, remoteQueries, signal);

                continue;
            }
            // 全ローカルで確保できる場合は、未使用リモートの照会を待たない。
            const unchecked = (picked === null || carriers === null
                ? candidates.flatMap(candidate => candidate.relTs !== undefined && candidate.relTs === candidate.channel.tsmfRelTs
                    ? candidate.devices.map(device => ({ device, channel: candidate.channel })) : [])
                : [
                    ...(picked.candidate.relTs !== undefined && picked.candidate.relTs === picked.channel.tsmfRelTs ? [picked] : []),
                    ...carriers
                ]).filter(({ device, channel }) => device.isRemote && !remoteChannels.get(device)?.has(channel) && !this._hasActiveRemoteRawInput(device, channel));
            if (unchecked.length > 0 && await this._checkRemoteChannels(unchecked, remoteChannels, signal, retryableLookups, remoteQueries)) { continue; }
            const uncheckedRaw = this._uncheckedRawTsmfDevices(picked, carriers, remoteChannelRelTs);
            if (uncheckedRaw.length > 0) {
                for (const device of uncheckedRaw) {
                    let reported = rawFailureReports.get(device);
                    if (!reported) { reported = new Set(); rawFailureReports.set(device, reported); }
                    await device.checkRemoteRawTsmf(signal, error => reportRemoteChannelFailure(reported, error));
                }
                continue;
            }
            if (viable.length === 0) {
                const lookupFailed = [...remoteChannels.values()].some(channels => [...channels.values()].includes(null));
                const rawRejected = candidates.flatMap(candidate => candidate.devices.filter(device => device.isRemote
                    && this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs) && device.supportsRemoteRawTsmf === false));
                const rawCheckErrors = rawRejected.map(device => device.remoteRawTsmfCheckError).filter(error => error !== undefined);
                const rawCheckError = rawCheckErrors.find(isRetryableRemoteLookupError) ?? rawCheckErrors[0];
                // _getCandidateは一時失敗中の相対TS用peerも省くため、元のdevice集合で原因を確認する。
                const relativeDevices = targets.flatMap(target => target.relTs !== undefined && target.relTs !== target.channel.tsmfRelTs
                    ? this._getDevicesByType(target.channel.type, target.channel.route).filter(device => device.isRemote)
                        .map(device => ({ device, channel: target.channel, relTs: target.relTs! })) : []);
                const relTsCheckErrors = relativeDevices.map(({ device, channel, relTs }) => device.getRemoteChannelRelTsCheckError?.(channel, relTs))
                    .filter(error => error !== undefined);
                const relTsCheckError = relTsCheckErrors.find(isRetryableRemoteLookupError) ?? relTsCheckErrors[0];
                const checkingSupport = relativeDevices.some(({ device }) => device.isRemoteRelTsChecked === false);
                const transient = retryableLookups.size > 0 || checkingSupport
                    || rawCheckError !== undefined && isRetryableRemoteLookupError(rawCheckError)
                    || relTsCheckError !== undefined && isRetryableRemoteLookupError(relTsCheckError);
                const reason = lookupFailed ? "リモートのチャンネル出力を確認できませんでした"
                    : relTsCheckError !== undefined ? "リモートの相対TSを確認できませんでした"
                        : rawCheckError !== undefined ? "リモートの生TSMF対応を確認できませんでした"
                            : checkingSupport ? "リモートの相対TS対応を確認しています"
                                : rawRejected.length > 0 ? "生TSMFの取得に対応するチューナーがありません" : "対応するチューナーがありません";
                const label = targets.map(({ channel }) => `${channel.type}/${channel.channel}`).join(", ");
                if (!transient) {
                    log.error(`❌ ${reason}: %s`, label);
                    return null;
                }
                // 通信障害で準備枠を占有し続けない。有限回の再確認後はJobの失敗・再試行へ戻す。
                // false/nullは意図したskipに使うため、照会失敗を成功扱いにしない。
                if (++transientFailures >= REMOTE_READY_LOOKUP_FAILURE_LIMIT) {
                    const cause = relTsCheckError ?? rawCheckError ?? [...remoteQueries.values()].find(query => query.retryable)?.error;
                    throw Object.assign(new Error(`${reason}。再確認の上限に達しました。`, cause !== undefined ? { cause } : undefined),
                        { code: "ERR_TUNER_UNAVAILABLE" });
                }
                if (!reportedWaiting) { log.warn(`⚠️ ${reason}: ${label}。10秒後に再確認します。`); reportedWaiting = true; }
            }
            if (viable.length > 0) { transientFailures = 0; }
            if (viable.length === 0 || picked === null || carriers === null) {
                await delay(1000 * 10, undefined, { signal });
                // 固定不適合は残し、準備待ちで再確認する失敗だけをこの要求内でも破棄する。
                for (const [device, failures] of retryableLookups) {
                    for (const channel of failures.keys()) { remoteChannels.get(device)?.delete(channel); }
                }
                retryableLookups.clear();
                // 成功した照会もdevice側と同じ60秒で更新し、古いPromiseで確認時刻だけを延長しない。
                const expired = new Set<string>();
                for (const [key, query] of remoteQueries) {
                    if (query.retryable || query.checkedAt !== undefined && Date.now() - query.checkedAt >= 60000) {
                        // Promiseは更新しても、同じ要求の警告済み記録は引き継ぐ。
                        query.expired = true;
                        expired.add(key);
                    }
                }
                for (const [device, channels] of remoteChannels) {
                    for (const channel of channels.keys()) {
                        if (expired.has(remoteChannelLookupKey(device, channel))) { channels.delete(channel); }
                    }
                }
                continue;
            }
            const { channel } = picked;
            signal?.throwIfAborted();
            // readyFn間の連続選択を短期間抑える。実使用の所有・競合はdeviceのchannel/usersとstartStreamが管理する。
            for (const { device } of [picked, ...carriers]) {
                this._readyForJobPickedDeviceSet.add(device);
                log.debug(`📡 デバイス #${device.index} を選択しました (${channel.type}/${channel.channel})`);
                let released = false;
                const release = () => {
                    // 同じ保持のtimerを一度だけ解放し、後から選択した別の呼出元の保持に触れない。
                    if (released) { return; }
                    released = true;
                    clearTimeout(timeout);
                    signal?.removeEventListener("abort", release);
                    this._readyForJobPickedDeviceSet.delete(device);
                    log.debug(`📡 デバイス #${device.index} を解放しました`);
                };
                const timeout = setTimeout(release, 1000 * 5);
                signal?.addEventListener("abort", release, { once: true });
                if (signal?.aborted) { release(); signal.throwIfAborted(); }
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
            const host = remoteChannelLookupKey(device, { type, channel });
            hosts.set(host, [...(hosts.get(host) || []), device]);
        }
        for (const hostDevices of hosts.values()) {
            try {
                const remoteChannel = await hostDevices[0].getRemoteChannel(type, channel);
                // detected by the remote Mirakurun, received by the tuners supporting it
                const detected = hostDevices.every(device => device.supportsRemoteRelTs) && (remoteChannel.services || []).some(service => Number.isInteger(service.tsmfRelTs) && service.tsmfRelTs! >= 1 && service.tsmfRelTs! <= 15);
                if (!remoteChannel.tsmfRelTs && !detected) {
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

        // 設定上のTS経路だけでは受信できるとは限らない。占有状態は見ず、対応デバイスと変換能力で判定する。
        const candidates = this._getCandidates(targets);
        const hasDevices = candidates.some(({ devices }) => devices.length > 0);
        const canConvert = candidates.some(({ format, devices }) =>
            devices.some(device => format === "ts" || !!device.config.tlvToTsDecoder));
        const format = requested || _.config.server.defaultTlvStreamFormat || "tlv";
        // 入力候補がない場合は変換不能と断定せず、確保側のチューナー不足として扱う。
        if (format === "ts" && hasDevices && canConvert === false) {
            return null;
        }
        return format;
    }

    /** @param relTs the relative stream of TSMF (default: `tsmfRelTs` of the channel, the stream as received if not specified) */
    initChannelStream(channel: ChannelItem, userReq: common.UserRequest, output: Writable, relTs?: number, rawTsmf = false): Promise<common.StreamFilter> {
        if (rawTsmf) {
            // formatは内側の論理形式であり、外側TSMFの未検出時にも使うためtlv設定だけで拒否しない。
            // 入力機器が外側TSを出力する構成で使用し、物理入力がTLVかどうかは設定から推測しない。
            // 搬送波は設定済みの相対TS・TLV形式・復号器を適用せず転送します。
            return this._initTS({ ...userReq, disableDecoder: true, streamSetting: { channel } }, output,
                [{ channel, devices: this._getDevicesByType(channel.type, channel.route), format: "ts", rawTsmf: true }]);
        }
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
            // この版のremote clientはHTTP・認証なしのため、接続先host/portとタイプだけで試行をまとめる。
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
            const host = remoteChannelLookupKey(device, channel);
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
                if (!Number.isInteger(service.tsmfRelTs) || service.tsmfRelTs! < 1 || service.tsmfRelTs! > 15 || (service.format !== "ts" && service.format !== "tlv") || streams.has(service.tsmfRelTs)) {
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
                for (const item of devices.filter(other => remoteChannelLookupKey(other, channel) === remoteChannelLookupKey(device, channel))) {
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
        log.info(`📡 ${channel.type}/${channel.channel} の相対TSを検出しました: ${streams.map(stream => `${stream.relTs}:${stream.format}(${stream.slots} slots)`).join(", ")}`);

        const savedStreams = channel.streams;
        let provisionalStreams: ChannelStream[] | undefined;
        let streamsCommitted = false;
        try {
            let scanStreams = streams;
            let carriersCompleted = false;
            // the stream of the services scanned (the same as without TSMF), the one of the TSMF header if no services
            // the stream as received of the remote Mirakurun is TS (TSMF)
            let channelStreams: ChannelStream[] = streams.map(stream => ({ ...stream, ...(remote && { remote: true }) }));
            const discovery = streams.find(stream => (stream.numberOfCarriers || 0) > 1 && stream.format === "tlv");
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
                    channel.setStreams(provisionalStreams = [...channelStreams]);
                }
                const canReceive = this.canReceiveTsmfCarriers(channel, discovery.numberOfCarriers!);
                if (!canReceive || !channel.hasAllCarriers(discovery)) {
                    log.info(`📡 ${channel.type}/${channel.channel} の相対TS ${discovery.relTs} は、グループ ${discovery.groupId} の全 ${discovery.numberOfCarriers} 搬送波が揃ってからTLVを取得します (${canReceive ? `検出済み搬送波: ${(channel.getBondedChannels() || []).length}、またはcarrier_sequenceが不正` : "ローカルチューナーが不足"})`);
                    // TS services on a shared carrier do not require the other carriers.
                    scanStreams = streams.filter(stream => stream.format === "ts");
                } else {
                    carriersCompleted = discoveryChanged;
                }
            } else if (!remote && channel.streams.some(stream => stream.remote === true) && _.channel.get(channel.type, channel.channel) === channel) {
                // the relative streams detected by the local tuners are received by them (not as detected by the remote Mirakurun)
                channel.setStreams(provisionalStreams = [...channelStreams]);
            }

            const scan = (stream: TSMFStream): Promise<apid.Service[]> => this._scanServices(
                channel,
                { ...userReq, streamSetting: { ...userReq.streamSetting! } },
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
            let lastError: unknown = null;
            results.forEach((result, index) => {
                const i = scanStreams === streams ? index : streams.indexOf(scanStreams[index]);
                if (result.status === "fulfilled") {
                    services.push(...result.value);
                    streamServices[i] = result.value;
                    if (result.value.length > 0) {
                        channelStreams[i] = { ...channelStreams[i], networkId: result.value[0].networkId, streamId: result.value[0].streamId ?? channelStreams[i].streamId };
                    }
                } else {
                    failed[i] = true;
                    lastError = result.reason;
                    log.warn(`⚠️ ${channel.type}/${channel.channel} の相対TS ${streams[i].relTs} のサービスを取得できませんでした (${lastError instanceof Error ? lastError.message : String(lastError)})`);
                    // the stream received before is kept (the format detected may be wrong if the scan has failed)
                    const saved = savedStreams.find(stream => stream.relTs === streams[i].relTs);
                    if (saved !== undefined) {
                        channelStreams[i] = { ...channelStreams[i], networkId: saved.networkId, streamId: saved.streamId, format: saved.format };
                    }
                }
            });
            // the other carriers scan the TLV only if it is not scanned by this (its services are added by any carrier)
            const tlvScanned = scanStreams.some((stream, index) => stream.format === "tlv" && results[index].status === "fulfilled" &&
                (results[index] as PromiseFulfilledResult<apid.Service[]>).value.length > 0);
            if (carriersCompleted && !tlvScanned) {
                // (the streams may be changed while scanning)
                for (const carrier of channel.getBondedChannels() || []) {
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
                ...((stream.numberOfCarriers || 0) > 1 && { numberOfCarriers: stream.numberOfCarriers }),
                ...(failed[i] && { failed: true })
            })));

            // the channel scan adds the carriers bonded without the services (the TLV is scanned when all the carriers are found)
            const allFailed = services.length === 0 && lastError !== null && !collect?.some(stream => stream.format === "tlv" && (stream.numberOfCarriers || 0) > 1);
            if (_.channel.get(channel.type, channel.channel) === channel && (!allFailed || (provisionalStreams !== undefined && channel.streams === provisionalStreams))) {
                // 全失敗の復旧は自分の仮経路だけを対象とし、別取得が確定した経路は上書きしない。
                channel.setStreams(channelStreams);
                streamsCommitted = true;
            }
            if (allFailed) {
                throw lastError;
            }
            return services;
        } finally {
            // 搬送波の検出に使った仮経路は、確定前の中断時に保存しない。
            // 待機中に別の取得が確定した経路は、そのsnapshotで巻き戻さない。
            if (!streamsCommitted && provisionalStreams !== undefined && channel.streams === provisionalStreams &&
                _.channel.get(channel.type, channel.channel) === channel) {
                channel.setStreams(savedStreams);
            }
        }
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
        if (!setting) { throw new Error("streamSetting is required"); }
        if (_.config.server.disableEITParsing === true) { setting.parseEIT = false; }
        candidates = candidates || [this._getCandidate(setting.channel, setting.channel.defaultRelTs)];
        if (dest && user.outputFormat) {
            const hadDevices = candidates.some(candidate => candidate.devices.length > 0);
            candidates = candidates.map(candidate => ({
                ...candidate,
                devices: candidate.format === "tlv"
                    ? (user.outputFormat === "ts" ? candidate.devices.filter(device => !!device.config.tlvToTsDecoder) : candidate.devices)
                    : (user.outputFormat === "tlv" ? [] : candidate.devices)
            }));
            if (hadDevices && !candidates.some(candidate => candidate.devices.length > 0)) {
                throw Object.assign(new Error("stream format is unavailable"), { code: "ERR_STREAM_FORMAT_UNAVAILABLE" });
            }
        }
        let tryCount = 50;
        const startedAt = Date.now();
        if (!dest) {
            // ローカルで検出した相対TSにはローカルを優先し、リモートのみなら従来どおり番組表を取得する。
            const remoteResult = await this._useRemoteData(user, candidates.flatMap(candidate => {
                if (candidate.relTs === candidate.channel.tsmfRelTs) { return candidate.devices; }
                const local = candidate.devices.filter(device => !device.isRemote);
                return local.length > 0 ? local : this._getDevicesByType(candidate.channel.type, candidate.channel.route).filter(device => device.isRemote);
            }));
            // remoteの取得・保存が完了した結果は、その後の中止要求で失敗へ戻さない。
            if (remoteResult) { return null; }

        }
        // リモートの既定出力を要求内で確認する。未確認・取得失敗を「生のTSMF」と推測しない。
        const remoteChannels: RemoteChannelStates = new Map();
        const remoteQueries: RemoteChannelQueries = new Map();
        const rawFailureReports = new Map<TunerDevice, Set<string>>();
        const remoteChannelRelTs: RemoteChannelRelTs = (device, channel) => remoteChannels.get(device)?.get(channel);
        const pick = () => this._pickTunerDeviceWithCarriers(candidates!, user.priority, undefined, remoteChannelRelTs);
        while (tryCount > 0) {

            const { picked, carriers: initialCarriers } = pick();
            let carriers = initialCarriers;
            if (picked !== null && this._isDetectedByRemote(picked.candidate, picked.device) && !picked.device.isRemoteChannelRelTsChecked(picked.channel, picked.candidate.relTs!)) {
                await this._checkRemoteRelativeForRequest(picked.device, picked.channel, picked.candidate.relTs!, remoteQueries);

                continue;
            }
            const unchecked = (picked === null || carriers === null
                ? candidates.flatMap(candidate => candidate.relTs !== undefined && candidate.relTs === candidate.channel.tsmfRelTs
                    ? candidate.devices.map(device => ({ device, channel: candidate.channel })) : [])
                : [
                    ...(picked.candidate.relTs !== undefined && picked.candidate.relTs === picked.channel.tsmfRelTs ? [picked] : []),
                    ...carriers
                ]).filter(({ device, channel }) => device.isRemote && !remoteChannels.get(device)?.has(channel) && !this._hasActiveRemoteRawInput(device, channel));
            if (unchecked.length > 0 && await this._checkRemoteChannels(unchecked, remoteChannels, undefined, undefined, remoteQueries)) { continue; }
            const uncheckedRaw = this._uncheckedRawTsmfDevices(picked, carriers, remoteChannelRelTs);
            if (uncheckedRaw.length > 0) {
                for (const device of uncheckedRaw) {
                    let reported = rawFailureReports.get(device);
                    if (!reported) { reported = new Set(); rawFailureReports.set(device, reported); }
                    await device.checkRemoteRawTsmf(undefined, error => reportRemoteChannelFailure(reported, error));
                }
                continue;
            }
            if (picked === null || carriers === null) {
                if (!candidates.some(candidate => this._hasCarrierDevices(candidate, remoteChannelRelTs))) {
                    const lookupFailed = [...remoteChannels.values()].some(channels => [...channels.values()].includes(null));
                    const rawRejected = candidates.flatMap(candidate => candidate.devices.filter(device => device.isRemote
                        && this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs) && device.supportsRemoteRawTsmf === false));
                    const rawCheckError = rawRejected.map(device => device.remoteRawTsmfCheckError).find(error => error !== undefined);
                    // 候補作成時に一時除外されたpeerも原因を確認し、空の候補を待ち続けない。
                    // 同じ要求では照会結果を固定し、再試行する呼出元が次の要求で候補を作り直す。
                    const relTsCheckError = candidates.flatMap(candidate => candidate.relTs === undefined ? []
                        : this._getDevicesByType(candidate.channel.type, candidate.channel.route)
                            .map(device => device.getRemoteChannelRelTsCheckError?.(candidate.channel, candidate.relTs!))).find(error => error !== undefined);
                    if (lookupFailed || rawRejected.length > 0 || relTsCheckError !== undefined) {
                        const message = lookupFailed ? "リモートのチャンネル出力を確認できませんでした。"
                            : relTsCheckError !== undefined ? "リモートの相対TSを確認できませんでした。"
                                : rawCheckError !== undefined ? "リモートの生TSMF対応を確認できませんでした。" : "生TSMFの取得に対応するチューナーがありません。";
                        const cause = relTsCheckError ?? rawCheckError;
                        throw Object.assign(new Error(message, cause !== undefined ? { cause } : undefined), { code: "ERR_TUNER_UNAVAILABLE" });
                    }
                }
                if (--tryCount <= 0) { break; }
                await common.sleep(250);
                continue;
            }
            let { device } = picked;
            const { channel, candidate } = picked;
            const isTlv = candidate.format === "tlv";
            const { relTs } = candidate;
            setting.channel = channel;
            setting.tsmfRelTs = candidate.rawTsmf ? undefined : relTs !== channel.tsmfRelTs ? relTs : undefined;
            // 選択時と同じ入力責務を使い、peerの設定変更後も配信中の同一入力へ合流する。
            user._rawTsmf = this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs);
            const remoteSplit = device.isRemote && relTs !== undefined && !user._rawTsmf;
            setting.format = user._rawTsmf ? "ts" : candidate.format;
            const filterRelTs = remoteSplit ? undefined : relTs;
            log.debug(`📡 チューナー#${device.index} を選択しました (${Date.now() - startedAt}ms、user=${user.id})`);
            const decoders: TSDecoder[] = [];
            // 生TSMFにはリモート復号を適用せず、ローカルに設定されたコマンドで展開後に復号する。
            const decoderCommand = user.disableDecoder === true ? null : user._rawTsmf ? (device.config.decoder || null) : device.decoder;
            const tlvDecoderCommand = isTlv ? device.config.tlvDecoder : undefined;
            const tlvToTsDecoderCommand = isTlv ? device.config.tlvToTsDecoder : undefined;
            const remoteDecoder = device.isRemote;
            let tsFilter: common.StreamFilter;
            if (isTlv) {
                const TLVFilter = (require("./TLVFilter") as typeof import("./TLVFilter")).default;
                tsFilter = new TLVFilter({
                    output: this._getTlvOutput(device, user, dest, decoders),
                    networkId: setting.networkId, serviceId: setting.serviceId, eventId: setting.eventId,
                    parseNIT: setting.parseNIT, parseSDT: setting.parseSDT, parseEIT: setting.parseEIT,
                    tsmfRelTs: filterRelTs, tsmfCarriers: carriers.length + 1
                });
            } else {
                let output = dest;
                if (decoderCommand !== null) {
                    const decoder = new TSDecoder({ output: dest!, command: decoderCommand });
                    decoders.push(decoder);
                    output = decoder;
                }
                tsFilter = new TSFilter({
                    output: output!, networkId: setting.networkId, serviceId: setting.serviceId, eventId: setting.eventId,
                    parseNIT: setting.parseNIT, parseSDT: setting.parseSDT, parseEIT: setting.parseEIT,
                    parseNetworkStreams: setting.parseNetworkStreams, tsmfRelTs: filterRelTs, rawTsmf: candidate.rawTsmf
                });
            }
            const releaseAttempt = () => {
                tsFilter.close(false);
                // 確保に失敗した試行が作成したdecoderだけを解放し、destの終了は呼出元に任せる。
                for (const decoder of decoders) { decoder.close(false); }
            };
            let starts: Promise<void>[] = [];
            try {
                for (const decoder of decoders) { await decoder.waitForStart(); }

                // decoder待機中の割込みを反映し、最終選択から確保開始まではawaitを挟まない。
                if (decoders.length > 0) {
                    const selected = pick();
                    if (selected.picked && this._isDetectedByRemote(selected.picked.candidate, selected.picked.device)
                        && !selected.picked.device.isRemoteChannelRelTsChecked(selected.picked.channel, selected.picked.candidate.relTs!)) {
                        releaseAttempt();
                        continue;
                    }
                    if (this._uncheckedRawTsmfDevices(selected.picked, selected.carriers, remoteChannelRelTs).length > 0) {
                        releaseAttempt();
                        continue;
                    }
                    const selectedDevice = selected.picked?.device;
                    const sameTarget = selected.picked?.channel === channel && selected.picked.candidate.format === candidate.format && selected.picked.candidate.relTs === relTs;
                    const knownRemoteInputs = selected.picked && [
                        ...(selected.picked.candidate.relTs !== undefined && selected.picked.candidate.relTs === selected.picked.channel.tsmfRelTs ? [selected.picked] : []),
                        ...(selected.carriers || [])
                    ].every(({ device, channel }) => !device.isRemote || this._hasActiveRemoteRawInput(device, channel) || remoteChannels.get(device)?.has(channel));
                    // 設定照会の結果が同じでも、待機中に生入力が始まると展開責務が変わるため作り直す。
                    const sameRemoteInput = selectedDevice && selectedDevice.isRemote === remoteDecoder
                        && (!remoteDecoder || remoteChannelRelTs(selectedDevice, channel) === remoteChannelRelTs(device, channel))
                        && selected.picked && this._needsRemoteRawTsmf(selected.picked.candidate, selectedDevice, remoteChannelRelTs) === (user._rawTsmf === true);
                    const sameDecoder = selectedDevice && (selectedDevice === device || (isTlv
                        ? selectedDevice.config.tlvDecoder === tlvDecoderCommand && selectedDevice.config.tlvToTsDecoder === tlvToTsDecoderCommand && selectedDevice.isRemote === remoteDecoder
                        : (user.disableDecoder === true ? null : user._rawTsmf ? (selectedDevice.config.decoder || null) : selectedDevice.decoder) === decoderCommand && selectedDevice.isRemote === remoteDecoder));
                    if (!selected.picked || selected.carriers === null || selected.carriers.length !== carriers.length || !sameTarget || !sameDecoder || !sameRemoteInput || !knownRemoteInputs) {
                        releaseAttempt(); --tryCount; continue;
                    }
                    device = selected.picked.device;
                    carriers = selected.carriers;
                }
                if (dest && user.disableDecoder !== true
                    && ((device.isRemote && user._rawTsmf && device.config.remoteMirakurunDecoder === true)
                        || carriers.some(carrier => carrier.device.isRemote && carrier.device.config.remoteMirakurunDecoder === true))
                    && !(isTlv ? device.config.tlvDecoder : device.config.decoder)) {
                    log.warn(`⚠️ 生TSMFの取得ではリモート復号を使用できません。ローカルの${isTlv ? "tlvDecoder" : "decoder"}が未設定のため、未復号で出力します。`);
                }
                // 選択変更で破棄する試行にはgetterを登録せず、再試行での再定義を避ける。
                Object.defineProperty(user, "streamInfo", { get: () => tsFilter.streamInfo });

                const sinks = carriers.map((_, i) => new CarrierSink(tsFilter as TLVFilter, i + 1));
                // 全搬送波の利用者を先に登録し、起動待ちの間に別の要求へ選択されないようにする。
                starts = [device.startStream(user, tsFilter, channel), ...carriers.map((carrier, i) => carrier.device.startStream(
                    { ...user, id: `${user.id}#carrier${i + 1}`, _rawTsmf: true, streamSetting: { channel: carrier.channel, format: "ts" } },
                    sinks[i], carrier.channel
                ))];
                await Promise.all(starts);

                return tsFilter;
            } catch (err) {
                releaseAttempt();
                // 一方の失敗後も、別搬送波の起動処理が完了してから返す。
                await Promise.allSettled(starts);
                // 確保自体の拒否は優先度判定を尊重して返し、別デバイスへのtakeoverを重ねない。
                throw err;
            }
        }
        throw Object.assign(new Error("no available tuners"), { code: "ERR_TUNER_UNAVAILABLE" });
    }

    /** 既定相対TSを要求内で確認し、確認できないリモートを生搬送波とみなさない。 */
    private _checkRemoteRelativeForRequest(device: TunerDevice, channel: ChannelItem, relTs: number,
        queries: RemoteChannelQueries, signal?: AbortSignal): Promise<boolean> {
        let query: RemoteChannelQuery | undefined;
        return device.checkRemoteChannelRelTs(channel, relTs, signal,
            () => { query = remoteChannelQuery(device, channel, queries, signal); return query.promise; },
            error => reportRemoteChannelFailure(query?.reported, error));
    }

    private async _checkRemoteChannels(
        targets: { device: TunerDevice, channel: ChannelItem }[],
        states: RemoteChannelStates,
        signal?: AbortSignal,
        retryableLookups?: RemoteChannelFailures,
        queries?: RemoteChannelQueries
    ): Promise<boolean> {
        // statesはready/acquisitionごとの所有物。同じ要求の後続選択でも照会済みの成否を共有する。
        // Promiseや通信自体を要求間で共有せず、各要求のabortと停止の責任を維持する。
        const checked = new Map<string, { configured: number | undefined | null; retryable: boolean }>();
        for (const [device, channels] of states) {
            for (const [channel, configured] of channels) {
                checked.set(remoteChannelLookupKey(device, channel), { configured, retryable: retryableLookups?.get(device)?.has(channel) === true });
            }
        }
        let changed = false;
        for (const { device, channel } of targets) {
            if (!device.isRemote || states.get(device)?.has(channel)) { continue; }
            signal?.throwIfAborted();

            const key = remoteChannelLookupKey(device, channel);
            const previous = checked.get(key);
            let configured: number | undefined | null;
            let retryable = false;
            if (previous) {
                configured = previous.configured;
                retryable = previous.retryable;
            } else {
                let query: RemoteChannelQuery | undefined;
                try {
                    query = queries && remoteChannelQuery(device, channel, queries, signal);
                    const remote = await (query?.promise ?? device.getRemoteChannel(channel.type, channel.channel,
                        signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)));
                    configured = remote.tsmfRelTs || undefined;
                    if (configured !== undefined && (!Number.isInteger(configured) || configured < 1 || configured > 15)) {
                        throw Object.assign(new Error("リモートの相対TS設定が不正です。"), { code: "ERR_REMOTE_CHANNEL_RELTS_INVALID" });
                    }
                } catch (error) {
                    signal?.throwIfAborted();
                    if (reportRemoteChannelFailure(query?.reported, error)) { log.warn(`⚠️ リモートのチャンネル ${channel.type}/${channel.channel} の出力を確認できないため、チューナー#${device.index} を新規起動の候補から外します (${error instanceof Error ? error.message : String(error)})`); }
                    configured = null;
                    retryable = isRetryableRemoteLookupError(error);
                }
                checked.set(key, { configured, retryable });
            }
            signal?.throwIfAborted();

            if (!states.has(device)) { states.set(device, new Map()); }
            // 一時失敗の共有先も10秒後に失効させる。恒久不適合と取得要求は再照会しない。
            if (retryable && retryableLookups) {
                if (!retryableLookups.has(device)) { retryableLookups.set(device, new Set()); }
                retryableLookups.get(device)!.add(channel);
            }
            states.get(device)!.set(channel, configured);
            changed = true;
        }
        return changed;
    }

    /** 実際に受信中の一致する外側TSは、能力APIの失敗や遅い設定照会より優先して共有する。 */
    private _hasActiveRemoteRawInput(device: TunerDevice, channel: ChannelItem): boolean {
        return device.isRemote && device.isAvailable && device.channel === channel && device.remoteRawTsmf === true
            && device.remoteRelTs === undefined && device.remoteFormat === "ts";
    }

    private _needsRemoteRawTsmf(candidate: TunerCandidate, device: TunerDevice, remoteChannelRelTs?: RemoteChannelRelTs): boolean {
        if (candidate.rawTsmf === true) { return true; }
        if (!device.isRemote || candidate.relTs === undefined || candidate.relTs !== candidate.channel.tsmfRelTs) { return false; }
        if (this._hasActiveRemoteRawInput(device, candidate.channel)) { return true; }
        // ローカルで設定相対TSを分離する場合は、単一搬送波でも原本を保証するrawTsmf対応が必要。
        // 旧peerの通常TS出力を原本と推測せず、同じ設定相対TSをpeer側で展開済みの場合だけ分離を省く。
        const configured = remoteChannelRelTs?.(device, candidate.channel);
        if (configured !== undefined) { return false; }
        // 設定が削除されても、配信中の同一相対TS・形式はそのまま共有できる。
        // 入力が異なる場合の新規起動・takeoverには、生TSMFの能力確認とローカル展開を適用する。
        return !(device.channel === candidate.channel && device.isAvailable && device.remoteRawTsmf === false
            && device.remoteRelTs === this._getRemoteRelTs(candidate) && device.remoteFormat === candidate.format);
    }

    private _uncheckedRawTsmfDevices(
        picked: { device: TunerDevice, candidate: TunerCandidate } | null,
        carriers: { device: TunerDevice, channel: ChannelItem }[] | null,
        remoteChannelRelTs: RemoteChannelRelTs
    ): TunerDevice[] {
        if (picked === null || carriers === null) { return []; }
        return [
            ...(this._needsRemoteRawTsmf(picked.candidate, picked.device, remoteChannelRelTs) ? [{ device: picked.device, channel: picked.candidate.channel }] : []),
            ...carriers
        ].filter(({ device, channel }) => device.isRemote && device.supportsRemoteRawTsmf === undefined
            && !this._hasActiveRemoteRawInput(device, channel)).map(({ device }) => device);
    }

    private _canUseRemoteCandidate(candidate: TunerCandidate, device: TunerDevice, remoteChannelRelTs?: RemoteChannelRelTs): boolean {
        if (!device.isRemote) { return true; }
        if (this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs) && this._hasActiveRemoteRawInput(device, candidate.channel)) { return true; }
        const configured = remoteChannelRelTs?.(device, candidate.channel);
        if (configured === null) { return false; }
        if (this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs) && device.supportsRemoteRawTsmf === false) { return false; }
        if (this._isDetectedByRemote(candidate, device)) { return device.canReceiveRemoteRelTs(candidate.channel, candidate.relTs!); }
        return candidate.relTs === undefined || configured === undefined || configured === candidate.relTs;
    }

    /**
     * the tuner and the tuners of the other bonded carriers,
     * by the remote tuners (bonding the TLV of the relative stream detected by themselves) if the local tuners of the carriers are not available
     * @returns `carriers` is `null` if not available
     */
    private _pickTunerDeviceWithCarriers(
        candidates: TunerCandidate[],
        priority: number,
        excluded?: Set<TunerDevice>,
        remoteChannelRelTs?: RemoteChannelRelTs
    ): { picked: { device: TunerDevice, channel: ChannelItem, candidate: TunerCandidate } | null, carriers: { device: TunerDevice, channel: ChannelItem }[] | null } {
        candidates = candidates.map(candidate => ({
            ...candidate,
            devices: candidate.devices.filter(device => this._canUseRemoteCandidate(candidate, device, remoteChannelRelTs))
        }));
        // the remote tuners for the relative stream detected come after the local tuners (taking over, and of the carriers),
        // the remote Mirakurun may not have detected it
        const isDetectedByRemote = (candidate: TunerCandidate, device: TunerDevice): boolean => this._isDetectedByRemote(candidate, device)
            || (device.isRemote && !this._hasActiveRemoteRawInput(device, candidate.channel) && candidate.relTs !== undefined && remoteChannelRelTs?.(device, candidate.channel) === candidate.relTs);
        const picked = this._pickTunerDevice(candidates.map(candidate => ({
            ...candidate,
            devices: candidate.devices.filter(device => !isDetectedByRemote(candidate, device))
        })), priority, remoteChannelRelTs);
        const carriers = picked === null ? null : this._pickCarrierDevices(picked, priority, excluded, remoteChannelRelTs);
        if (picked !== null && carriers !== null) {
            return { picked, carriers };
        }
        const remoteCandidates = candidates.map(candidate => ({
            ...candidate,
            devices: candidate.devices.filter(device => isDetectedByRemote(candidate, device))
        })).filter(candidate => candidate.devices.length > 0);
        const remote = remoteCandidates.length > 0 ? this._pickTunerDevice(remoteCandidates, priority, remoteChannelRelTs) : null;
        return remote === null ? { picked, carriers: null } : { picked: remote, carriers: this._pickCarrierDevices(remote, priority, excluded, remoteChannelRelTs) };
    }

    /** whether the tuners exist for all the bonded carriers of the candidate (in use or not) */
    private _hasCarrierDevices(candidate: TunerCandidate, remoteChannelRelTs?: RemoteChannelRelTs): boolean {
        const primaryDevices = candidate.devices.filter(device => this._canUseRemoteCandidate(candidate, device, remoteChannelRelTs));
        if (primaryDevices.length === 0) { return false; }
        const channels = candidate.relTs && candidate.format === "tlv" ? candidate.channel.getBondedChannels() : null;
        // 検出済み・照会で一致した相対TSと、既に配信中の同一入力はリモート側で結合済み。
        if (channels === null || channels.length < 2 || primaryDevices.some(device => device.isRemote
            && candidate.relTs !== undefined && !this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs))) {
            return true;
        }
        const detected = this._getRemoteRelTs(candidate) !== undefined;
        const devices = new Set<TunerDevice>();
        for (const channel of channels) {
            const carrierDevices = channel === candidate.channel ? primaryDevices : this._getDevicesByType(channel.type, channel.route)
                .filter(device => !device.isRemote || (!detected && (this._hasActiveRemoteRawInput(device, channel) || remoteChannelRelTs?.(device, channel) !== null && device.supportsRemoteRawTsmf !== false)));
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
        excluded: Set<TunerDevice> = new Set(),
        remoteChannelRelTs?: RemoteChannelRelTs
    ): { device: TunerDevice, channel: ChannelItem }[] | null {
        // the relative stream detected is requested from the remote Mirakurun (bonds the carriers by itself, not of `tsmfRelTs` of channels.yml)
        const detected = this._getRemoteRelTs(candidate) !== undefined;
        // the TLV of the relative stream of TSMF
        const remoteSplit = device.isRemote && candidate.relTs !== undefined && !this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs);
        const channels = candidate.relTs && candidate.format === "tlv" && !remoteSplit ? channel.getBondedChannels() : null;
        if (channels === null || channels.length < 2) {
            return [];
        }

        const used = new Set([device, ...excluded]);
        const picked: { device: TunerDevice, channel: ChannelItem }[] = [];
        for (const carrierChannel of channels) {
            if (carrierChannel === channel) {
                continue;
            }
            // rawTsmfはリモートの相対TS設定を適用しない。能力が未確認の候補は開始前に照会する。
            const carrier = this._pickTunerDevice([{
                channel: carrierChannel, relTs: carrierChannel.tsmfRelTs, format: "ts", rawTsmf: true,
                devices: this._getDevicesByType(carrierChannel.type, carrierChannel.route).filter(d =>
                    !(d.isRemote && (detected || !this._hasActiveRemoteRawInput(d, carrierChannel) && (remoteChannelRelTs?.(d, carrierChannel) === null || d.supportsRemoteRawTsmf === false))) && !used.has(d))
            }], priority, remoteChannelRelTs);
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
    private _getTlvOutput(device: TunerDevice, user: common.User, dest?: Writable, decoders: TSDecoder[] = []): Writable | undefined {
        if (!dest) {
            return dest;
        }

        let output = dest;
        const firstDecoder = decoders.length;
        try {
            if (user.outputFormat === "ts") {
                // a stream in TS must not be continued in TLV
                const decoder = new TSDecoder({
                    output,
                    command: device.config.tlvToTsDecoder!,
                    withArgs: true,
                    startupTimeout: TLV_DECODER_STARTUP_TIMEOUT,
                    passThroughOnFailure: false
                });
                decoders.push(decoder);
                output = decoder;
            }
            if (user.disableDecoder !== true && device.config.tlvDecoder && (!device.isRemote || user._rawTsmf)) {
                const decoder = new TSDecoder({
                    output,
                    command: device.config.tlvDecoder,
                    withArgs: true,
                    startupTimeout: TLV_DECODER_STARTUP_TIMEOUT
                });
                decoders.push(decoder);
                output = decoder;
            }
            return output;
        } catch (error) {
            // 後段の生成に失敗した場合も、この呼出しが作成したdecoderだけを解放する。
            for (let i = firstDecoder; i < decoders.length; i++) { decoders[i].close(false); }
            throw error;
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
     * 各段階で、すべての候補のチャンネルを順に探す (前の候補を優先する)
     */
    private _pickTunerDevice(
        candidates: TunerCandidate[],
        priority: number,
        remoteChannelRelTs?: RemoteChannelRelTs
    ): { device: TunerDevice, channel: ChannelItem, candidate: TunerCandidate } | null {
        candidates = candidates.map(candidate => ({ ...candidate, devices: candidate.devices.filter(device =>
            !device.isRemote || !this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs) || device.supportsRemoteRawTsmf !== false || this._hasActiveRemoteRawInput(device, candidate.channel)) }));
        // 1. join to existing (the remote tuner outputs a relative stream of TSMF)
        for (const candidate of candidates) {
            for (const device of candidate.devices) {
                const rawTsmf = this._needsRemoteRawTsmf(candidate, device, remoteChannelRelTs);
                if (device.isAvailable === true && device.channel === candidate.channel &&
                    (!device.isRemote || (device.remoteRelTs === this._getRemoteRelTs(candidate)
                        && device.remoteFormat === (rawTsmf ? "ts" : candidate.format) && device.remoteRawTsmf === rawTsmf))) {
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
            // 旧リモートの既定出力には別の相対TSが含まれることもあるため、判別済みの相対TSの代わりには使わない。
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
