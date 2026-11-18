/*
   Copyright 2017 kanreisa

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
import { Operation } from "express-openapi";
import * as api from "../../../api";
import * as apid from "../../../../../api";
import * as config from "../../../config";
import * as common from "../../../common";
import ChannelItem from "../../../ChannelItem";
import type { ScanAttempt, ScannedStream } from "../../../Tuner";
import type TunerDevice from "../../../TunerDevice";
import { SYS } from "../../../dvb/constants";
import _ from "../../../_";

/**
 * Options for a channel scan operation
 */
/** the source of the channels to scan */
export type ChannelScanSource = apid.ChannelScanSource;

interface ChannelScanOption {
    route: apid.ChannelRoute;          // Receiving route
    source?: ChannelScanSource;        // Source of the channels to scan
    channels?: string[];               // Channels to scan (source: list)
    dvbChannels?: string[];            // Channels of the channel config files of dvbv5 (source: dvbConf)
    channelNameFormat?: string;        // Channel name format (source: format)
    startCh?: number;                  // Start channel number (source: format)
    endCh?: number;                    // End channel number (source: format)
    startSubCh?: number;               // Start subchannel number (source: format, `{subch}` in the format)
    endSubCh?: number;                 // End subchannel number (source: format, `{subch}` in the format)
    scanMode?: apid.ChannelScanMode;   // Scan mode (default: by the type of the stream)
    setDisabledOnAdd?: boolean;        // Set disabled flag on newly added channels (default: by the type of the stream)
}

/**
 * Configuration for a scan operation
 */
interface ScanConfig {
    readonly channels: string[];                 // List of channel identifiers to scan
    readonly scanMode?: apid.ChannelScanMode;    // Scan mode to use (default: by the type)
    readonly setDisabledOnAdd?: boolean;         // Whether to set disabled on new channels (default: by the type)
}

/**
 * Service types supported for scanning
 * 0x01 = デジタルTVサービス
 * 0x02 = デジタル音声サービス
 * 0xA1 = 臨時映像サービス
 * 0xA4 = エンジニアリングサービス
 * 0xA5 = プロモーション映像サービス
 * 0xAD = 超高精細度4K専用TVサービス
 * 0xC0 = データサービス
 */
const serviceTypes = [0x01, 0x02, 0xA1, 0xA4, 0xA5, 0xAD, 0xC0];

/**
 * Options for string comparison when sorting channels
 */
const compareOptions: Intl.CollatorOptions = {
    sensitivity: "base" as const,
    numeric: true
};

/**
 * Channel type order for sorting
 */
const channelOrder: Record<apid.ChannelType, number> = {
    GR: 1,
    BS: 2,
    CS: 3,
    SKY: 4,
    BS4K: 5,
    CATV: 6
};

/**
 * Global flag to track if scan cancellation is requested
 */
let isCancellationRequested = false;

/** the scan is being prepared (the status is of the previous scan) */
let isPreparing = false;

/**
 * Global object to track current scan status
 */
const scanStatus: apid.ChannelScanStatus = {
    isScanning: false,
    status: "not_started"
};

/**
 * Generate an array of numbers in a range
 *
 * @param start The start number of the range (inclusive)
 * @param end The end number of the range (inclusive)
 * @returns Array of numbers from start to end
 */
function range(start: number, end: number): number[] {
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => i + start);
}

/**
 * Format a channel name using placeholders
 *
 * @param format The format string with placeholders like {ch}, {ch00}, {subch}
 * @param ch The channel number
 * @param subch The optional subchannel number
 * @returns The formatted channel name
 *
 * Supported placeholder formats:
 * - {ch} - Channel number
 * - {ch0}, {ch00}, etc. - Channel number with zero padding
 * - {subch} - Subchannel number
 * - {subch0}, {subch00}, etc. - Subchannel number with zero padding
 */
function formatChannelName(format: string, ch: number, subch?: number): string {
    const values = new Map<string, string>();
    // Find all placeholders in format {name}
    const placeholders = format.match(/({[\\_a-zA-Z0-9]+})/g);

    if (placeholders) {
        for (const placeholder of placeholders) {
            // Handle {ch} or {ch00} style placeholders
            const chDigits = placeholder.match(/{ch([0]*)}/);
            if (chDigits) {
                const digits = chDigits[1] ? chDigits[1].length : 1;
                values.set(placeholder, (ch ?? 0).toString(10).padStart(digits, "0"));
            }

            // Handle {subch} or {subch00} style placeholders
            const subchDigits = placeholder.match(/{subch([0]*)}/);
            if (subchDigits) {
                const digits = subchDigits[1] ? subchDigits[1].length : 1;
                values.set(placeholder, (subch ?? 0).toString(10).padStart(digits, "0"));
            }
        }
    }

    // Replace all placeholders with their values
    let formatted = format;
    for (const [key, value] of values) {
        while (formatted.includes(key)) {
            formatted = formatted.replace(key, value);
        }
    }

    return formatted;
}

/** the channels of a format in the ranges (`{subch}` in the format for the subchannels) */
function formatChannels(format: string, startCh: number, endCh: number, startSubCh = 0, endSubCh = 3): string[] {
    const channels: string[] = [];
    for (const ch of range(startCh, endCh)) {
        if (/{subch0*}/.test(format)) {
            channels.push(...range(startSubCh, endSubCh).map(subCh => formatChannelName(format, ch, subCh)));
        } else {
            channels.push(formatChannelName(format, ch));
        }
    }
    return channels;
}

/**
 * the channels to scan by default for each route (the names of the tuner commands such as recpt1, recisdb)
 * - TER: the terrestrial channels (UHF 13-62)
 * - SAT: the BS (`BS01_0`-`BS23_3`) and CS (`CS2`-`CS24`) channels
 * - SKY: none (the channels of SKY are tuned by the channel config files of dvbv5)
 * - CATV: the cable channels (VHF `1`-`12`, `C13`-`C63`) and the terrestrial channels passed through (13-62)
 * - FTTH: the terrestrial, BS and CS channels passed through
 */
export function getPresetChannels(route: apid.ChannelRoute): string[] {
    const terrestrial = formatChannels("{ch}", 13, 62);
    const satellite = [...formatChannels("BS{ch00}_{subch}", 1, 23, 0, 3), ...formatChannels("CS{ch}", 2, 24)];
    switch (route) {
        case "TER":
            return terrestrial;
        case "SAT":
            return satellite;
        case "CATV":
            return [...formatChannels("{ch}", 1, 12), ...formatChannels("C{ch}", 13, 63), ...terrestrial];
        case "FTTH":
            return [...terrestrial, ...satellite];
    }
    return [];
}

/**
 * Generates a scan configuration for the options
 *
 * @param option The scan options including the route and the source of the channels
 * @returns A scan configuration with channels to scan and associated settings, `undefined` if invalid
 */
export function generateScanConfig(option: ChannelScanOption | LegacyChannelScanOption): ScanConfig | undefined {
    // 旧type指定の空文字は既定書式。明示source=formatだけ空欄を拒否する。
    if (!("type" in option) && option.source === "format" && option.channelNameFormat !== undefined && option.channelNameFormat.trim() === "") {
        throw new Error("チャンネル名の書式を指定してください。");
    }
    if ("type" in option) { return generateLegacyCompatConfig(option); }
    if (common.channelRoutes.includes(option.route) === false) {
        return undefined;
    }

    let channels: string[];
    switch (option.source || "preset") {
        case "preset":
            if (option.route === "SKY") {
                throw new Error("SKYにはプリセットがありません。チャンネル一覧、dvbv5設定ファイル、または書式を指定してください。");
            }
            channels = getPresetChannels(option.route);
            break;
        case "dvbConf":
            channels = option.dvbChannels || [];
            break;
        case "list":
            channels = (option.channels || []).map(channel => channel.trim()).filter(channel => channel !== "");
            if (channels.length === 0) { throw new Error("スキャンするチャンネルを1件以上指定してください。"); }
            break;
        case "format":
            if (option.channelNameFormat === undefined) { throw new Error("チャンネル名の書式を指定してください。"); }
            if (option.startCh === undefined || option.endCh === undefined) {
                throw new Error("書式から取得する開始番号と終了番号を指定してください。");
            }
            if (!/{subch0*}/.test(option.channelNameFormat) && (option.startSubCh !== undefined || option.endSubCh !== undefined)) {
                throw new Error("minSubCh・maxSubChは、channelNameFormatに{subch}を含む場合だけ指定できます。");
            }
            channels = formatChannels(option.channelNameFormat, option.startCh, option.endCh, option.startSubCh, option.endSubCh);
            break;
        default:
            return undefined;
    }
    channels = [...new Set(channels)];
    if (channels.length === 0) {
        return undefined;
    }

    return {
        channels,
        ...(option.scanMode && { scanMode: option.scanMode }),
        ...(option.setDisabledOnAdd !== undefined && { setDisabledOnAdd: option.setDisabledOnAdd })
    };
}

/** the scan by `type` of 4.3.0 */
interface LegacyChannelScanOption {
    type: apid.ChannelType;            // GR, BS or CS
    channelNameFormat?: string;        // Channel name format
    startCh?: number;                  // Start channel number
    endCh?: number;                    // End channel number
    startSubCh?: number;               // Start subchannel number (BS of the subchannel style)
    endSubCh?: number;                 // End subchannel number (BS of the subchannel style)
    useSubCh?: boolean;                // BS of the subchannel style (default: true)
    scanMode?: apid.ChannelScanMode;   // Scan mode (default: by the type of the stream)
    setDisabledOnAdd?: boolean;        // Set disabled flag on newly added channels (default: by the type of the stream)
}

/** the types of the scan by `type` of 4.3.0 */
export const legacyScanTypes: apid.ChannelType[] = ["GR", "BS", "CS"];

/**
 * Generates a scan configuration of the scan by `type` of 4.3.0 (the channels of the type by the parameters of 4.3.0)
 * - GR: `{ch}` 13-62
 * - BS: `BS{ch00}_{subch}` 1-23, 0-3 (`useSubCh`, default), or `{ch}` 101-256
 * - CS: `CS{ch}` 2-24
 * @returns `undefined` if invalid
 */
function generateLegacyCompatConfig(option: LegacyChannelScanOption): ScanConfig | undefined {
    let defaults: { format: string, startCh: number, endCh: number };
    if (option.type === "GR") {
        defaults = { format: "{ch}", startCh: 13, endCh: 62 };
    } else if (option.type === "BS") {
        defaults = option.useSubCh === false ? { format: "{ch}", startCh: 101, endCh: 256 } : { format: "BS{ch00}_{subch}", startCh: 1, endCh: 23 };
    } else if (option.type === "CS") {
        defaults = { format: "CS{ch}", startCh: 2, endCh: 24 };
    } else {
        return undefined;
    }
    // the subchannels only for BS of the subchannel style
    const subCh = option.type === "BS" && option.useSubCh !== false;
    const channelNameFormat = option.channelNameFormat || defaults.format;
    const hasSubCh = /{subch0*}/.test(channelNameFormat);
    return generateScanConfig({
        route: common.getDefaultChannelRoute(option.type),
        source: "format",
        channelNameFormat,
        startCh: option.startCh ?? defaults.startCh,
        endCh: option.endCh ?? defaults.endCh,
        // 旧形式で使用しないサブ番号は、経路形式の検証へ持ち込まない。
        startSubCh: subCh ? option.startSubCh : hasSubCh ? 0 : undefined,
        endSubCh: subCh ? option.endSubCh : hasSubCh ? 0 : undefined,
        scanMode: option.scanMode,
        setDisabledOnAdd: option.setDisabledOnAdd
    });
}

/** the channels to skip by `skipCh` of 4.3.0 (the numbers in the names) */
export function getLegacySkipChannels(channels: string[], skipCh: string[]): string[] {
    const numbers = skipCh.map(ch => parseInt(ch, 10)).filter(ch => !isNaN(ch));
    return channels.filter(channel => skipCh.includes(channel) || numbers.includes(parseInt(channel.replace(/[^0-9]/g, ""), 10)));
}

/**
 * the channel type of a stream by the network (original_network_id of the services)
 * @returns `null` if unknown
 */
export function getChannelTypeByNetwork(networkId: number, format: apid.StreamFormat): apid.ChannelType | null {
    if (format === "tlv") {
        return "BS4K";
    }
    if (networkId === 4) {
        return "BS";
    }
    if (networkId === 6 || networkId === 7) {
        return "CS";
    }
    if (networkId === 1 || networkId === 3 || networkId === 10) {
        return "SKY";
    }
    // the terrestrial (ARIB TR-B14)
    if (networkId >= 0x7880 && networkId <= 0x7FE8) {
        return "GR";
    }
    // the services of the cable television itself (such as the community channels)
    if (common.CATV_NETWORK_IDS.includes(networkId)) {
        return "CATV";
    }
    return null;
}

/** the types of the broadcasts of each route (the tuners without `routes` receive any route) */
const routeTypes: Record<apid.ChannelRoute, apid.ChannelType[]> = {
    TER: ["GR"],
    SAT: ["BS", "CS", "BS4K"],
    SKY: ["SKY"],
    CATV: ["GR", "BS", "CS", "BS4K", "SKY", "CATV"],
    FTTH: ["GR", "BS", "CS", "BS4K", "SKY", "CATV"]
};

/**
 * the tuners (and the type of the channel item) to try a channel for the scan, covering all the tuners of the route
 * (such as the tuners of ISDB-T and ISDB-S on FTTH), the types of the satellite first for the channels named BS / CS
 */
export function getScanAttempts(route: apid.ChannelRoute, channel?: string, types: apid.ChannelType[] = routeTypes[route]): ScanAttempt[] {
    const satellite = channel !== undefined && /^(BS|CS)/i.test(channel);
    const order: apid.ChannelType[] = satellite ? ["BS", "CS", "BS4K", "SKY", "GR", "CATV"] : ["GR", "BS", "CS", "BS4K", "SKY", "CATV"];
    return _.tuner.getScanAttempts(route, order.filter(type => routeTypes[route].includes(type) && types.includes(type)));
}

/** the transponders of BS (right-hand circular polarization, BS-1, 3, ..., 23): kHz */
const BS_FIRST_FREQUENCY = 11727480;
const BS_FREQUENCY_STEP = 38360;
/** the local oscillator of the LNB for BS (the frequencies of the channel config files of dvbv5 are of the IF) */
const BS_LO_FREQUENCY = 10678000;

/**
 * the transponder of BS (1, 3, ..., 23) of a frequency (kHz, of the broadcast or of the IF)
 * @returns `null` if not of BS (right-hand circular polarization)
 */
export function getBsTransponder(frequency: number): number | null {
    for (const lo of [0, BS_LO_FREQUENCY]) {
        const offset = frequency + lo - BS_FIRST_FREQUENCY;
        const index = Math.round(offset / BS_FREQUENCY_STEP);
        if (index >= 0 && index <= 11 && Math.abs(offset - index * BS_FREQUENCY_STEP) <= 2000) {
            return index * 2 + 1;
        }
    }
    return null;
}

/** the streams (TSID) of each transponder of BS by NIT */
export type BsStreams = Map<number, number[]>;

/** @returns `null` if not NIT of BS, or the transponder of a stream is unknown (the channels are not skipped) */
export function getBsStreams(network: common.NetworkStreams): BsStreams | null {
    if (network.networkId !== 4 || network.streams.length === 0) {
        return null;
    }
    const bsStreams: BsStreams = new Map();
    for (const stream of network.streams) {
        const transponder = stream.frequency === undefined ? null : getBsTransponder(stream.frequency);
        if (transponder === null) {
            return null;
        }
        bsStreams.set(transponder, [...(bsStreams.get(transponder) || []), stream.streamId]);
    }
    return bsStreams;
}

/**
 * the channel of BS on a tuner: the transponder (the even numbers are of the left-hand circular polarization, only of TLV),
 * and the stream (TSID) if known by the channel config file of dvbv5
 */
export interface BsChannel {
    transponder: number;
    streamId?: number;
}

/**
 * the channel of BS on a tuner, by the channel config file of dvbv5 (FREQUENCY and STREAM_ID),
 * by the name (`BSxx_y`, xx: the transponder) on the tuners of the other commands
 * @returns `null` if not of BS (by the channel config file of dvbv5, only of the right-hand circular polarization)
 */
export async function getBsChannel(device: TunerDevice, route: apid.ChannelRoute, channel: string): Promise<BsChannel | null> {
    const conf = await device.getDvbChannelStream(route, channel).catch((): null => null);
    if (conf === undefined) {
        const name = /^BS(\d+)_\d+$/i.exec(channel);
        const transponder = name ? parseInt(name[1], 10) : 0;
        return transponder >= 1 && transponder <= 23 ? { transponder } : null;
    }
    const transponder = conf?.deliverySystem === SYS.ISDBS ? getBsTransponder(conf.frequency) : null;
    if (transponder === null) {
        return null;
    }
    // STREAM_ID is TSID, or the relative number of the stream in the transponder (0-7)
    return { transponder, ...(conf.streamId > 7 && { streamId: conf.streamId }) };
}

/**
 * whether a channel of BS is not broadcast in TS by NIT of BS:
 * - the transponder not in NIT: not broadcast in TS (the transponders of TLV are not in NIT)
 * - the stream (TSID) known: not in NIT
 * - the stream unknown: all the streams of the transponder are already received by the scan (by the other channels)
 * @param tlv the tuner receives TLV
 * @param received the streams (TSID) received by the scan, by the channels of BS of the transponder
 */
export function isAbsentBsChannel(bsStreams: BsStreams, channel: BsChannel, tlv: boolean, received: Set<number>): boolean {
    const streams = bsStreams.get(channel.transponder);
    if (streams === undefined) {
        return !tlv;
    }
    if (channel.streamId !== undefined) {
        return !streams.includes(channel.streamId);
    }
    return streams.every(streamId => received.has(streamId));
}

/** the error of the scan of a channel to show: 2 = other errors, 1 = no signal, 0 = the channel not in the channel config of dvbv5 */
function getScanErrorRank(error: unknown): number {
    const text = String(error);
    if (/stream has closed before get network/.test(text)) {
        return 1;
    }
    return /channel .+ is not found in /.test(text) ? 0 : 2;
}

interface ScannedChannelRetention {
    incompleteTypes: Set<apid.ChannelType>;
    carrierTypes: Set<apid.ChannelType>;
}

/**
 * the channel items of a channel scanned (by the type of each stream)
 * @param log writes the notes
 * @param remoteType the type of the channel received by the remote tuners (the remote Mirakurun receives only the channel of the type configured)
 * @param relTsByRemote the types received only by the remote tuners outputting the relative streams of the channel (`Tuner.receivesRelTsByRemote()`)
 */
export function generateScannedChannelItems(
    channel: string,
    route: apid.ChannelRoute,
    streams: ScannedStream[],
    scanConfig: ScanConfig,
    log: (text: string) => void = () => undefined,
    remoteType?: apid.ChannelType,
    relTsByRemote: apid.ChannelType[] = [],
    retention?: ScannedChannelRetention
): apid.ConfigChannels {
    const types = new Map<apid.ChannelType, { relTs: Set<number | undefined>, services: apid.Service[], bonded: boolean, incomplete: boolean }>();
    let hasUnidentifiedStream = false;
    const observedTypes = new Set<apid.ChannelType>();
    for (const stream of streams) {
        const services = stream.services.filter(service => serviceTypes.includes(service.type));
        const bonded = stream.format === "tlv" && stream.numberOfCarriers > 1;
        // 対象外サービスだけのTSもネットワーク自体は確認できている。
        const networkId = stream.services[0]?.networkId ?? stream.networkId;
        let type = getChannelTypeByNetwork(networkId, stream.format);
        if (remoteType !== undefined && type !== remoteType) {
            log(`-> received by the remote tuner as ${remoteType}${type === null ? "" : ` (the network is of ${type})`}, added as ${remoteType}.\n`);
            type = remoteType;
        }
        // 未知の相対TSは未観測種別だけを保護する。正常に確認できた種別の移転・廃止は反映する。
        if (type === null) {
            hasUnidentifiedStream = true;
        } else if (stream.failed && !routeTypes[route].includes(type)) {
            // 経路と識別済み種別が矛盾する失敗は、既知種別を含め削除・相対TS変更の根拠にしない。
            for (const existingType of common.channelTypes) { retention?.incompleteTypes.add(existingType); }
        } else if (!routeTypes[route].includes(type)) {
            // 経路外の受信結果では、このチャンネルの未観測種別が廃止されたとは確認できない。
            hasUnidentifiedStream = true;
        }
        if (type === null) {
            log(`-> unknown network (networkId: ${networkId}${stream.relTs ? `, relTs: ${stream.relTs}` : ""}), skipped.\n`);
            continue;
        }
        if (routeTypes[route].includes(type)) { observedTypes.add(type); }
        // the carriers of a TLV of multiple carriers are added without the services (the services are scanned after all the carriers are known),
        // the relative stream failed to scan is counted by the network of the TSMF header (not to specify the other relative stream of the type)
        if (services.length === 0 && !bonded && !stream.failed) {
            continue;
        }
        // such as SKY on SAT (the satellite of SKY is received on the route SKY)
        if (routeTypes[route].includes(type) === false) {
            log(`-> ${type} (networkId: ${networkId}) is not of the route ${route}, skipped.\n`);
            continue;
        }
        if (stream.failed) {
            // such as the relative stream for the engineering (without SDT), the scan does not add it
            log(`-> the services of the relative stream ${stream.relTs} (${type}) are not received (it may have no services, such as for the engineering).` +
                ` if it has services, scan the channel again with refresh to add them.\n`);
        }
        const entry = types.get(type) || { relTs: new Set(), services: [], bonded: false, incomplete: false };
        entry.relTs.add(stream.relTs);
        entry.services.push(...services.filter(service => !entry.services.some(s => s.networkId === service.networkId && s.serviceId === service.serviceId)));
        entry.bonded = entry.bonded || bonded;
        entry.incomplete = entry.incomplete || stream.failed === true || (bonded && services.length === 0);
        types.set(type, entry);
    }

    const items: apid.ConfigChannels = [];
    for (const [type, { relTs, services, bonded, incomplete }] of types) {
        if (incomplete) { retention?.incompleteTypes.add(type); }
        if (services.length === 0 && bonded) { retention?.carrierTypes.add(type); }
        // only the relative streams failed to scan
        if (services.length === 0 && !bonded) {
            continue;
        }
        const scanMode = scanConfig.scanMode || (type === "GR" ? "Channel" : "Service");
        const setDisabledOnAdd = scanConfig.setDisabledOnAdd ?? type !== "GR";
        // the relative stream of TSMF is specified if only one (any tuner receives it), the relative streams are detected if more than one,
        // not specified for the remote tuners (the remote Mirakurun outputs the relative streams detected by itself)
        const byRemote = remoteType !== undefined || relTsByRemote.includes(type);
        const tsmfRelTs = relTs.size === 1 && !bonded && !byRemote ? [...relTs][0] : undefined;
        if (relTs.size > 1) {
            log(`-> the ${relTs.size} relative streams of ${type} are detected by the service scan.\n`);
        }
        if (_.tuner.typeExists(type, route) === false) {
            log(`-> no tuners of ${type} for the route ${route}, add ${type} to \`types\` of the tuners.\n`);
        }

        // 未取得サービスの搬送波行は次の受信に必要なため有効にする。
        const typeItems = services.length > 0
            ? generateChannelItems(scanMode, type, channel, services, setDisabledOnAdd)
            : [{ name: `${type}${channel}`, type, channel, isDisabled: false }];
        for (const item of typeItems) {
            if (route !== common.getDefaultChannelRoute(type)) {
                item.route = route;
            }
            if (tsmfRelTs !== undefined) {
                item.tsmfRelTs = tsmfRelTs;
            }
            items.push(item);
        }
    }
    if (retention && (hasUnidentifiedStream || retention.incompleteTypes.size > 0)) {
        // 一部の相対TSを取得できない場合、未観測の種別が消えたとは確認できない。
        for (const type of common.channelTypes) {
            if (!observedTypes.has(type)) { retention.incompleteTypes.add(type); }
        }
    }
    return items;
}

/**
 * Generates a channel item for a specific service
 *
 * @param type The channel type (GR, BS, CS, SKY)
 * @param channel The channel identifier
 * @param service The service information
 * @param setDisabledOnAdd Whether to set the channel as disabled initially
 * @returns A channel configuration object
 */
export function generateChannelItemForService(
    type: apid.ChannelType,
    channel: string,
    service: apid.Service,
    setDisabledOnAdd: boolean
): apid.ConfigChannelsItem {
    // Use service name, or fallback to generated name if empty
    let name = service.name.trim();
    if (name.length === 0) {
        name = `${type}${channel}:${service.serviceId}`;
    }

    return {
        name,
        type,
        channel,
        serviceId: service.serviceId,
        isDisabled: setDisabledOnAdd
    };
}

/**
 * Generates a channel item for a channel with multiple services
 * Finding a common prefix among all service names for the channel name
 *
 * @param type The channel type (GR, BS, CS, SKY)
 * @param channel The channel identifier
 * @param services Array of services on this channel
 * @param setDisabledOnAdd Whether to set the channel as disabled initially
 * @returns A channel configuration object
 */
export function generateChannelItemForChannel(
    type: apid.ChannelType,
    channel: string,
    services: apid.Service[],
    setDisabledOnAdd: boolean
): apid.ConfigChannelsItem {
    // Find the common prefix among all service names
    const baseName = services[0].name;
    let matchIndex = baseName.length;

    // Compare each service name with the base name to find the common prefix
    for (let servicesIndex = 1; servicesIndex < services.length; servicesIndex++) {
        const service = services[servicesIndex];
        for (let nameIndex = 0; nameIndex < baseName.length && nameIndex < service.name.length; nameIndex++) {
            // If characters don't match
            if (baseName[nameIndex] !== service.name[nameIndex]) {
                if (nameIndex === 0) {
                    break; // No common prefix at all
                }
                if (nameIndex < matchIndex) {
                    matchIndex = nameIndex; // Update the match length
                }
                break;
            }
            // If this service name is shorter and is a prefix of the base name
            if (nameIndex + 1 >= service.name.length && service.name.length < matchIndex) {
                matchIndex = service.name.length;
                break;
            }
        }
    }

    // Extract and clean up the common prefix
    let name = baseName.slice(0, matchIndex).trim();
    if (name.length === 0) {
        name = `${type}${channel}`; // Fallback name if no common prefix
    }

    return {
        name,
        type,
        channel,
        isDisabled: setDisabledOnAdd
    };
}

/**
 * Generates channel items based on scan mode, either per service or per channel
 *
 * @param scanMode The scan mode (Service or Channel)
 * @param type The channel type (GR, BS, CS, SKY)
 * @param channel The channel identifier
 * @param services Array of services found on this channel
 * @param setDisabledOnAdd Whether to set new channels as disabled
 * @returns Array of channel configuration objects
 */
export function generateChannelItems(
    scanMode: apid.ChannelScanMode,
    type: apid.ChannelType,
    channel: string,
    services: apid.Service[],
    setDisabledOnAdd: boolean
): apid.ConfigChannels {
    // Service mode: create one channel item per service
    if (scanMode === "Service") {
        return services.map(service =>
            generateChannelItemForService(type, channel, service, setDisabledOnAdd)
        );
    }

    // Channel mode: create one channel item for all services
    return [generateChannelItemForChannel(type, channel, services, setDisabledOnAdd)];
}
/**
 * Base interface for scan status updates
 */
interface BaseScanStatusUpdate {
    channel?: string;
    type?: apid.ChannelType;
}

/**
 * Interface for phase status updates
 */
interface PhaseScanStatusUpdate extends BaseScanStatusUpdate {
    status: apid.ChannelScanPhase;
    error?: string;
    saved?: boolean;
    dryRun?: boolean;
}

/**
 * Interface for step status updates
 */
interface StepScanStatusUpdate extends BaseScanStatusUpdate {
    status: apid.ChannelScanStep;
    progress?: number;
    enabled?: boolean;
    reason?: string;
    items?: apid.ConfigChannels;
    count?: number;
}

/**
 * Interface for result status updates
 */
interface ResultScanStatusUpdate extends BaseScanStatusUpdate {
    status: apid.ChannelScanResultType;
    newCount?: number;
    takeoverCount?: number;
    result?: apid.ConfigChannels;
}

/**
 * Union type for all scan status updates
 */
type ScanStatusUpdate = PhaseScanStatusUpdate | StepScanStatusUpdate | ResultScanStatusUpdate;

/**
 * Executes the channel scanning process
 *
 * @param scanConfig Configuration for the scan including channels to scan
 * @param dryRun If true, don't save changes
 * @param route Receiving route being scanned
 * @param refresh Whether to rescan channels that already exist
 * @param outputWriter Optional function to write output text during scan
 * @param skipCh Channels to skip (the names)
 * @param legacyType the type of the scan by `type` of 4.3.0 (scanned by the tuners of the type)
 * @param byNetwork skips the channels of BS not broadcast in TS by NIT of BS (`isAbsentBsChannel()`)
 * @returns Promise resolving to the final channel list
 */
async function runChannelScan(
    scanConfig: ScanConfig,
    dryRun: boolean,
    route: apid.ChannelRoute,
    refresh: boolean,
    outputWriter?: (text: string) => void,
    skipCh: string[] = [],
    legacyType?: apid.ChannelType,
    byNetwork = false
): Promise<apid.ConfigChannels> {
    try {
        // Initialize scan data
        const scanLog: string[] = [];
        const oldChannelItems = await config.loadChannels();
        // the entries of the channels scanned on the route (of any type) are replaced
        // (only of the type by `type` of 4.3.0, scanned only by the tuners of the type)
        const isOnRoute = (item: apid.ConfigChannelsItem): boolean => (item.route || common.getDefaultChannelRoute(item.type)) === route;
        const isReplaced = (item: apid.ConfigChannelsItem): boolean => isOnRoute(item) && (legacyType === undefined || item.type === legacyType);
        const isSkipped = (channel: string): boolean => skipCh.includes(channel);
        const selectedChannels = new Set(scanConfig.channels);
        const scannedChannels = new Set([...selectedChannels].filter(channel => !isSkipped(channel)));
        // この版では旧type指定もスキャンしたチャンネルだけを置換し、範囲外の設定は残す。
        const isInScope = (item: apid.ConfigChannelsItem): boolean => isReplaced(item) && scannedChannels.has(item.channel);
        const result: apid.ConfigChannels = oldChannelItems.filter(item => !isInScope(item));
        const acquiredItems: apid.ConfigChannels = [];
        // 取得失敗やrefresh=falseで省略したチャンネルは、保存時の最新行を引き継ぐ。
        const replacedChannels = new Set<string>();
        const retainedChannelTypes = new Map<string, Set<apid.ChannelType>>();
        const carrierShells = new WeakSet<apid.ConfigChannelsItem>();
        const typeChannelKey = (item: apid.ConfigChannelsItem): string => `${item.type}/${item.channel}`;
        const mergeIncompleteItems = (current: Readonly<apid.ConfigChannels>, acquired: apid.ConfigChannels) => {
            const existing = new Map<string, apid.ConfigChannels>();
            for (const item of current) {
                if (!isInScope(item) || !retainedChannelTypes.get(item.channel)?.has(item.type)) { continue; }
                const key = typeChannelKey(item);
                const rows = existing.get(key);
                if (rows) { rows.push(item); } else { existing.set(key, [item]); }
            }
            // 未完了の取得でサービス範囲を広げたり、指定された相対TSを変えたりしない。
            const items = acquired.filter(item => {
                const rows = existing.get(typeChannelKey(item));
                // 旧設定の0・null・空文字は未指定として比較し、共有設定は変更しない。
                return !rows || (!carrierShells.has(item) && item.serviceId !== undefined
                    && rows.every(row => {
                        const relTs: unknown = row.tsmfRelTs;
                        return row.serviceId !== undefined &&
                            (relTs === undefined || relTs === null || relTs === 0 || relTs === "" || relTs === item.tsmfRelTs);
                    }));
            });
            const replacements = new Map<string, Set<number | undefined>>();
            for (const item of items) {
                const key = typeChannelKey(item);
                if (!replacements.has(key)) { replacements.set(key, new Set()); }
                replacements.get(key).add(item.serviceId);
            }
            const retained = new Set(current.filter(item => isInScope(item) && existing.has(typeChannelKey(item))
                && !replacements.get(typeChannelKey(item))?.has(item.serviceId)));
            return { items, retained };
        };
        let newCount = 0;
        let takeoverCount = 0;
        // the streams of BS by NIT (`undefined` until a channel of BS is received, `null` if not known by it)
        let bsStreams: BsStreams | null | undefined = byNetwork ? undefined : null;
        const receivedBsStreams = new Set<number>();

        // Initialize global scan status
        const now = Date.now();
        Object.assign(scanStatus, {
            status: "scanning" as const,
            route,
            type: legacyType,
            dryRun,
            progress: 0,
            currentChannel: "",
            scanLog,
            newCount,
            takeoverCount,
            result: [],
            startTime: now,
            updateTime: now
        });

        /**
         * Updates scan phase status
         * @param update Phase status update
         * @param textOutput Optional text output for logs
         */
        const updatePhaseStatus = (update: PhaseScanStatusUpdate, textOutput?: string): void => {
            scanStatus.status = update.status;
            if (update.channel) {
                scanStatus.currentChannel = update.channel;
            }

            appendToLog(textOutput);
        };

        /**
         * Updates scan step status
         * @param update Step status update
         * @param textOutput Optional text output for logs
         */
        const updateStepStatus = (update: StepScanStatusUpdate, textOutput?: string): void => {
            if (update.progress !== undefined) {
                scanStatus.progress = update.progress;
            }
            if (update.channel) {
                scanStatus.currentChannel = update.channel;
            }
            scanStatus.updateTime = Date.now();

            appendToLog(textOutput);
        };

        /**
         * Updates scan result status
         * @param update Result status update
         * @param textOutput Optional text output for logs
         */
        const updateResultStatus = (update: ResultScanStatusUpdate, textOutput?: string): void => {
            if (update.newCount !== undefined) {
                scanStatus.newCount = update.newCount;
            }
            if (update.takeoverCount !== undefined) {
                scanStatus.takeoverCount = update.takeoverCount;
            }
            if (update.result) {
                scanStatus.result = normalizePublicScanResult(update.result);
            }

            appendToLog(textOutput);
        };

        /**
         * Appends text to scan log and writes output
         * @param textOutput Text to append
         */
        const appendToLog = (textOutput?: string): void => {
            if (textOutput) {
                const trimmedText = textOutput.trim();
                scanStatus.scanLog.push(trimmedText);
                if (outputWriter) {
                    outputWriter(textOutput);
                }
            }
        };

        // Print dry run notice if applicable
        if (dryRun) {
            appendToLog("-- dry run --\n\n");
        }

        // Print scan start message
        updateStepStatus(
            { status: "started" as const },
            `channel scanning... (route: "${route}")\n\n`
        );

        // Process each channel in the scan configuration
        const totalChannels = scanConfig.channels.length;
        for (let i = 0; i < totalChannels; i++) {
            // Check if scanning has been cancelled
            if (isCancellationRequested) {
                updatePhaseStatus(
                    { status: "cancelled" as const },
                    "Channel scan was cancelled by user request.\n"
                );
                break;
            }
            const channel = scanConfig.channels[i];
            const progressPercent = Math.round((i + 1) / totalChannels * 100);

            // Check if this channel should be skipped based on skipCh parameter
            if (isSkipped(channel)) {
                updateStepStatus(
                    {
                        status: "skipped" as const,
                        channel,
                        reason: "skip_parameter",
                        progress: progressPercent
                    },
                    `channel: "${channel}" (${i + 1}/${totalChannels}) [${progressPercent}%] - skipped by skipCh parameter\n\n`
                );
                continue; // Skip to next channel
            }

            // Update status to show current channel being scanned
            updateStepStatus(
                {
                    status: "scanning_channel" as const,
                    channel,
                    progress: progressPercent
                },
                `channel: "${channel}" (${i + 1}/${totalChannels}) [${progressPercent}%] ...\n`
            );

            // Check for existing enabled channels if we're not refreshing
            if (!refresh) {
                const existingChannels = oldChannelItems.filter(
                    item => isReplaced(item) &&
                           item.channel === channel &&
                           !item.isDisabled
                );

                // If there are existing channels, take them over instead of scanning
                if (existingChannels.length > 0) {
                    const takeoverInfo = {
                        status: "takeover" as const,
                        channel,
                        count: existingChannels.length,
                        items: existingChannels
                    };

                    updateStepStatus(
                        takeoverInfo,
                        `-> ${existingChannels.length} existing config found.\n`
                    );

                    // Add each existing channel to results (all the entries of the channel on the route)
                    for (const channelItem of oldChannelItems.filter(item => isReplaced(item) && item.channel === channel)) {
                        result.push(channelItem);
                        takeoverCount++;
                        scanStatus.takeoverCount = takeoverCount;
                        appendToLog(`-> ${JSON.stringify(channelItem)}\n`);
                    }

                    updateStepStatus(
                        {
                            status: "skipped" as const,
                            channel,
                            reason: "existing_config"
                        },
                        `# scan has skipped due to the "refresh = false" option because an existing config was found.\n\n`
                    );

                    continue; // Skip to next channel
                }
            }

            // Scan the streams of the channel (the type is decided by the network of each stream),
            // by the tuners of the route until received (the tuners of the route may receive the different systems)
            let streams: ScannedStream[] = null;
            let received: ScanAttempt = null;
            let lastError: Error = null;
            let attempts = getScanAttempts(route, channel, legacyType && [legacyType]);
            // the channel of BS on each tuner (by the first channel of BS received, the channels not broadcast are skipped)
            const bsChannels = new Map<TunerDevice, BsChannel | null>();
            if (bsStreams !== null) {
                for (const device of attempts.flatMap(attempt => attempt.devices)) {
                    bsChannels.set(device, await getBsChannel(device, route, channel));
                }
            }
            // not tried by the tuners of BS
            let absentInBs = false;
            if (bsStreams) {
                const knownStreams = bsStreams;
                const count = attempts.length;
                attempts = attempts.filter(attempt => attempt.devices.some(device => {
                    const bsChannel = bsChannels.get(device);
                    return !bsChannel || !isAbsentBsChannel(knownStreams, bsChannel, common.isTlvTuner(device.config), receivedBsStreams);
                }));
                absentInBs = attempts.length < count;
            }
            const collectsBsStreams = bsStreams === undefined && [...bsChannels.values()].some(bsChannel => bsChannel !== null);
            for (const attempt of attempts) {
                if (isCancellationRequested) {
                    break;
                }
                try {
                    streams = await _.tuner.scanChannel(new ChannelItem({
                        name: `${route}:${channel}`,
                        type: attempt.type,
                        channel,
                        route
                    }), {
                        id: "Mirakurun:API:channelScan",
                        priority: 1
                    }, attempt.devices, collectsBsStreams);
                    received = attempt;
                    break;
                } catch (error) {
                    // the error other than no signal is shown, no signal over the channel not in the channel config of dvbv5
                    // (the tuners of the other types may not receive the channel)
                    if (lastError === null || getScanErrorRank(error) > getScanErrorRank(lastError)) {
                        lastError = error;
                    }
                }
            }
            if (isCancellationRequested) {
                continue; // the cancellation is handled at the next channel
            }
            // not tried by any tuners, or the other tuners (such as of the terrestrial) do not have the channel in the channel config files of dvbv5
            if (streams === null && absentInBs && (lastError === null || getScanErrorRank(lastError) === 0)) {
                // NITで不在が確認できたチャンネルだけは、取得失敗と区別して旧行を置き換える。
                replacedChannels.add(channel);
                updateStepStatus(
                    {
                        status: "skipped" as const,
                        channel,
                        reason: "not_in_network",
                        progress: progressPercent
                    },
                    "-> not broadcast in TS by NIT of BS, skipped.\n\n"
                );
                continue; // Skip to next channel
            }
            if (streams === null) {
                const error = lastError;
                // Handle errors (often no signal)
                const isNoSignalError = /stream has closed before get network/.test(String(error));
                const errorInfo = {
                    status: "error" as const,
                    channel,
                    reason: isNoSignalError ? "no_signal" : String(error),
                    progress: progressPercent
                };

                let errorText = "-> no signal.";
                if (!isNoSignalError) {
                    errorText += ` [${error}]`;
                }
                errorText += "\n\n";

                updateStepStatus(errorInfo, errorText);
                continue; // Skip to next channel
            }

            replacedChannels.add(channel);
            const serviceCount = streams.reduce((count, stream) => count + stream.services.filter(service => serviceTypes.includes(service.type)).length, 0);
            updateStepStatus(
                {
                    status: "services_found" as const,
                    channel,
                    count: serviceCount
                },
                `-> ${serviceCount} services found.\n`
            );

            if (collectsBsStreams) {
                const network = streams.find(stream => stream.networkStreams !== undefined)?.networkStreams;
                bsStreams = network ? getBsStreams(network) : null;
                if (bsStreams) {
                    appendToLog(`-> ${network.streams.length} streams of BS are known by NIT, the channels of BS not broadcast in TS are skipped.\n`);
                }
            }
            // the streams of the transponder received by the channel of BS on the tuners
            // (not by the other channels carrying the streams of BS, such as of the cable television)
            if (bsStreams) {
                const transponderStreams = received.devices.flatMap(device => bsStreams.get(bsChannels.get(device)?.transponder) || []);
                for (const stream of streams) {
                    if (stream.services[0]?.networkId === 4 && transponderStreams.includes(stream.services[0].streamId)) {
                        receivedBsStreams.add(stream.services[0].streamId);
                    }
                }
            }

            // Generate channel items by the type of each stream
            const remoteType = received.devices.every(device => device.isRemote) ? received.type : undefined;
            // the types received only by the remote tuners outputting the relative streams (`tsmfRelTs` is not written)
            const relTsByRemote: apid.ChannelType[] = [];
            if (remoteType === undefined && streams.some(stream => stream.relTs !== undefined)) {
                for (const type of routeTypes[route]) {
                    if (await _.tuner.receivesRelTsByRemote(type, route, channel)) {
                        relTsByRemote.push(type);
                    }
                }
            }
            const retention: ScannedChannelRetention = { incompleteTypes: new Set(), carrierTypes: new Set() };
            const generated = generateScannedChannelItems(channel, route, streams, scanConfig, appendToLog, remoteType, relTsByRemote, retention);
            if (retention.incompleteTypes.size > 0) { retainedChannelTypes.set(channel, retention.incompleteTypes); }
            for (const item of generated) { if (retention.carrierTypes.has(item.type)) { carrierShells.add(item); } }
            const partial = mergeIncompleteItems(oldChannelItems as apid.ConfigChannels, generated);
            const scannedItems = partial.items;
            // 別経路との重複で開始時に候補を失わず、保存直前の最新設定で採否を決める。
            for (const item of scannedItems) { acquiredItems.push(item); }
            for (const item of partial.retained) { result.push(item); }
            takeoverCount += partial.retained.size;
            scanStatus.takeoverCount = takeoverCount;
            if (scannedItems.length === 0) {
                appendToLog("\n");
                continue;
            }

            // the channels are unique by the type and the channel (the entry of the other route is used if loaded:
            // the disabled one and the one of the route without the tuners of the type are not loaded)
            const addedItems = scannedItems.filter(item => {
                const other = result.find(o => o.type === item.type && o.channel === item.channel && !isOnRoute(o) && !o.isDisabled &&
                    (o.route === undefined || common.channelRoutes.includes(o.route)) &&
                    _.tuner.typeExists(o.type, o.route || common.getDefaultChannelRoute(o.type)));
                if (other) {
                    appendToLog(`-> ${item.type} "${item.channel}" is already configured on the route ${other.route || common.getDefaultChannelRoute(other.type)}, not added.\n`);
                    return false;
                }
                // `type` of 4.3.0: the entries of the other types remain
                if (legacyType !== undefined && item.type !== legacyType && result.some(o => o.type === item.type && o.channel === item.channel && isOnRoute(o))) {
                    appendToLog(`-> ${item.type} "${item.channel}" is already configured, not added (scanned by \`type\` ${legacyType}).\n`);
                    return false;
                }
                return true;
            });
            if (addedItems.length === 0) {
                appendToLog("\n");
                continue;
            }

            // Add newly scanned items to results
            for (const newChannelItem of addedItems) {
                result.push(newChannelItem);
                newCount++;
                scanStatus.newCount = newCount;
                appendToLog(`-> ${JSON.stringify(newChannelItem)}\n`);
            }

            updateStepStatus(
                {
                    status: "channels_found" as const,
                    channel,
                    items: addedItems
                },
                `Found ${addedItems.length} channels for ${channel}\n\n`
            );
        }

        const mergeResult = (current: Readonly<apid.ConfigChannels>): apid.ConfigChannels => {
            const partial = mergeIncompleteItems(current, acquiredItems);
            const retained = current.filter(item => !isInScope(item) || !replacedChannels.has(item.channel) || partial.retained.has(item));
            // 別経路で新たに有効化された行も、保存時の最新設定で確認する。
            const otherRoutes = new Set(retained.filter(other => !isOnRoute(other) && !other.isDisabled
                && (other.route === undefined || common.channelRoutes.includes(other.route))
                && _.tuner.typeExists(other.type, other.route || common.getDefaultChannelRoute(other.type))).map(typeChannelKey));
            const configuredOtherTypes = new Set(legacyType === undefined ? [] : retained.filter(item => isOnRoute(item) && item.type !== legacyType).map(typeChannelKey));
            const items = partial.items.filter(item => !otherRoutes.has(typeChannelKey(item)) && !configuredOtherTypes.has(typeChannelKey(item)));
            result.length = 0;
            for (const item of retained) { result.push(item); }
            for (const item of items) { result.push(item); }
            newCount = items.length;
            // 0件の取得結果も確定する従来契約を維持する。引継ぎはskipChを含む今回の選択範囲だけを数える。
            takeoverCount = retained.filter(item => isReplaced(item) && selectedChannels.has(item.channel)).length;
            scanStatus.newCount = newCount;
            scanStatus.takeoverCount = takeoverCount;
            result.sort((a, b) => a.type === b.type ? a.channel.localeCompare(b.channel, undefined, compareOptions) : channelOrder[a.type] - channelOrder[b.type]);
            return result;
        };
        if (!isCancellationRequested) {
            if (dryRun) {
                mergeResult(await config.loadChannels() as apid.ConfigChannels);
            } else {
                // 同じI/Oキュー内で最新設定の取得と保存を行い、並行PUTの更新を巻き戻さない。
                await config.mergeAndSaveChannels(mergeResult);
            }
        }

        // Generate and display summary
        const summaryData = {
            status: "summary" as const,
            newCount,
            takeoverCount,
            totalTypeCount: newCount + takeoverCount,
            totalCount: result.length
        };

        updateResultStatus(
            summaryData,
            `-> total ${newCount + takeoverCount}/${result.length} (${legacyType ?? route}/Any) channels configured.\n\n`
        );

        updateResultStatus(
            { status: "summary_new" as const, newCount },
            `-> new ${newCount} channels found.\n`
        );

        updateResultStatus(
            { status: "summary_takeover" as const, takeoverCount },
            `-> existing ${takeoverCount} channels merged.\n`
        );

        // If canceled, do not set to Completed
        if (!isCancellationRequested) {
            // Save results if not a dry run
            if (!dryRun) {
                updatePhaseStatus(
                    { status: "completed" as const, saved: true },
                    "channel scan has been completed and saved successfully.\n"
                );
                updateResultStatus(
                    { status: "restart_required" as const },
                    "**RESTART REQUIRED** to apply changes.\n"
                );
            } else {
                updatePhaseStatus(
                    { status: "completed" as const, dryRun: true },
                    "channel scan has been completed.\n\n-- dry run --\n"
                );
            }
        }

        // Send final result
        updateResultStatus(
            {
                status: "final_result" as const,
                result
            },
            `Final result: ${result.length} channels\n`
        );

        return result;
    } finally {
        // Always reset scanning and cancellation flags when done
        scanStatus.isScanning = false;
        isCancellationRequested = false;
    }
}

/** 旧設定の0・null・空文字は未指定として公開し、保存・統合に使う設定と候補を変更しない。 */
function normalizePublicScanResult(channels: Readonly<apid.ConfigChannels>): apid.ConfigChannels {
    return channels.map(channel => {
        const relTs: unknown = channel.tsmfRelTs;
        if (relTs !== 0 && relTs !== null && relTs !== "") { return channel; }
        const normalized = { ...channel };
        delete normalized.tsmfRelTs;
        return normalized;
    });
}

/**
 * Get channel scan status - API handler
 */
export const get: Operation = async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // 旧設定を含む状態も複製して公開し、共有中の設定・結果を変更しない。
    const snapshot: apid.ChannelScanStatus = { ...scanStatus, scanLog: scanStatus.scanLog?.slice(),
        result: scanStatus.result && normalizePublicScanResult(scanStatus.result)
    };
    api.responseJSON(res, snapshot);
};

get.apiDoc = {
    tags: ["config"],
    summary: "Get Channel Scan Status",
    description: "Returns the current or last completed scan status and results",
    operationId: "getChannelScanStatus",
    produces: [
        "application/json"
    ],
    responses: {
        200: {
            description: "OK",
            schema: {
                $ref: "#/definitions/ChannelScanStatus"
            }
        }
    }
};

/**
 * Initiate a channel scan - API handler
 */
export const put: Operation = async (req, res) => {
    // queryの型変換前に上限で切られた条件を、受理済みの指定として扱わない。
    // URL上限はSDK・Web UIとそろえ、Nodeの既定ヘッダー上限にも余裕を残す。
    const requestUrl = req.originalUrl || req.url || "";
    if (Buffer.byteLength(requestUrl) > 8192) {
        api.responseError(res, 400, "スキャン条件が長すぎます。符号化済みURLを8192バイト以下にしてください。チャンネル一覧やスキップの指定を分けてから、再度開始してください。");
        return;
    }
    const queryStart = requestUrl.indexOf("?");
    if (queryStart !== -1 && requestUrl.slice(queryStart + 1).split("&").length >= 1000) {
        api.responseError(res, 400, "クエリーのパラメーター数は1000未満にしてください。channelsとskipChはそれぞれカンマ区切りの1キーで指定してください。");
        return;
    }

    // Check if a scan is already in progress
    if (scanStatus.isScanning === true) {
        api.responseError(res, 409, "Already Scanning");
        return;
    }

    // the scan is not started (the cancellation requested while preparing is also reset)
    const reject = (reason: string): void => {
        scanStatus.isScanning = false;
        isPreparing = false;
        isCancellationRequested = false;
        api.responseError(res, 400, reason);
    };

    // Set scanning flag
    scanStatus.isScanning = true;
    isPreparing = true;

    // the scan by `type` of 4.3.0: the channels of the type by the parameters of 4.3.0, by the tuners of the type on the default route of the type
    // (the type of each stream is decided by its network)
    const legacyType = req.query.type as apid.ChannelType;
    if (legacyType !== undefined) {
        if (legacyScanTypes.includes(legacyType) === false) {
            reject(`\`type\` must be one of ${legacyScanTypes.join(", ")}`);
            return;
        }
        // 明示した経路の不一致を既定値として無視せず、別経路の誤走査を受付前に防ぐ。
        const defaultRoute = common.getDefaultChannelRoute(legacyType);
        if ((req.query.route !== undefined && req.query.route !== defaultRoute) ||
            (req.query.source !== undefined && req.query.source !== "preset")) {
            reject("typeのrouteには種別の既定経路、sourceにはpresetだけを指定できます。");
            return;
        }
    }

    // Extract query parameters
    const asyncMode = Boolean(req.query.async);
    const dryRun = Boolean(req.query.dryRun);
    // type省略は経路別presetへの意図した移行で、旧GRの範囲指定・同種別全体の置換へ推測で戻さない。
    // 旧形式の範囲指定はtypeを明示するかsource=formatへ移行する。指定方法と置換範囲はAPI Docsを参照する。
    const route = legacyType !== undefined ? common.getDefaultChannelRoute(legacyType) : (req.query.route as apid.ChannelRoute) || "TER";
    const refresh = Boolean(req.query.refresh);
    const source = legacyType !== undefined ? "format" : (req.query.source as ChannelScanSource) || "preset";
    const ignoredRangeParameters = ["minCh", "maxCh", "minSubCh", "maxSubCh", "channelNameFormat"]
        .filter(name => req.query[name] !== undefined);
    if (legacyType === undefined && source !== "format" && ignoredRangeParameters.length > 0) {
        reject(`${ignoredRangeParameters.join("・")}はsource=${source}では使用できません。範囲を指定する場合はsource=formatと書式、または従来のtypeを指定してください。`);
        return;
    }
    // useSubChは旧type指定だけの選択肢。経路形式は書式の{subch}で決め、指定を無視しない。
    if (legacyType === undefined && req.query.useSubCh !== undefined) {
        reject("useSubChは従来のtype指定でのみ使用できます。typeを省略する場合はuseSubChを外し、サブ番号が必要な場合はsource=formatの書式に{subch}を含めてください。");
        return;
    }
    if (req.query.channels !== undefined && source !== "list") {
        reject(legacyType !== undefined
            ? "typeとchannelsは併用できません。チャンネル一覧を指定する場合はtypeを省略し、routeとsource=listを指定してください。"
            : "channelsはsource=listでのみ指定できます。チャンネル一覧を指定する場合はsource=listを指定してください。");
        return;
    }
    const toList = (value: unknown): string[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String);
    // the channels of BS not broadcast in TS are skipped by NIT of BS (not the channels specified by `list` / `format`)
    const byNetwork = legacyType === undefined && (source === "preset" || source === "dvbConf") && (route === "SAT" || route === "FTTH");

    // この版の旧type指定は名前・名前中の数字も受け付ける互換契約を維持する。
    // 5.0の主番号だけを使う制約は、識別子を渡す既存クライアントへ遡って適用しない。
    // Parse skipCh parameter (the names, or the numbers of 4.3.0 with `type`)
    let skipCh = toList(req.query.skipCh).map(name => name.trim()).filter(name => name.length > 0);

    const scanTypes = [...new Set(getScanAttempts(route, undefined, legacyType && [legacyType]).map(attempt => attempt.type))];
    if (scanTypes.length === 0 && source === "dvbConf") {
        reject(legacyType !== undefined ? `No tuners for the type ${legacyType}` : `No tuners for the route ${route}`);
        return;
    }
    // 受付前のdvbConf読込もDELETEで取消し可能。読込の成否より取消しを優先する。
    const cancelPreparation = (): boolean => {
        if (!isCancellationRequested) { return false; }
        scanStatus.isScanning = false;
        isPreparing = false;
        isCancellationRequested = false;
        res.status(204);
        res.end();
        return true;
    };
    const getDvbChannelNames = async (): Promise<string[]> => {
        const names = new Set<string>();
        for (const type of scanTypes) {
            (await _.tuner.getDvbChannelNames(route, type)).forEach(name => names.add(name));
        }
        return [...names];
    };

    let scanConfig: ScanConfig;
    try {
        // Parse channel configuration options
        const channelOptions: ChannelScanOption = {
            route,
            source,
            channels: toList(req.query.channels),
            dvbChannels: source === "dvbConf" ? await getDvbChannelNames() : undefined,
            channelNameFormat: req.query.channelNameFormat as string,
            startCh: req.query.minCh !== undefined ? Number(req.query.minCh) : undefined,
            endCh: req.query.maxCh !== undefined ? Number(req.query.maxCh) : undefined,
            startSubCh: req.query.minSubCh !== undefined ? Number(req.query.minSubCh) : undefined,
            endSubCh: req.query.maxSubCh !== undefined ? Number(req.query.maxSubCh) : undefined,
            scanMode: req.query.scanMode as apid.ChannelScanMode,
            setDisabledOnAdd: req.query.setDisabledOnAdd !== undefined ? Boolean(req.query.setDisabledOnAdd) : undefined
        };

        // Generate scan configuration
        scanConfig = legacyType !== undefined ? generateScanConfig({
            ...channelOptions,
            type: legacyType,
            useSubCh: req.query.useSubCh !== undefined ? Boolean(req.query.useSubCh) : undefined
        }) : generateScanConfig(channelOptions);
    } catch (error) {
        if (cancelPreparation()) { return; }
        // such as a range too large (the scan is not started)
        reject(error.message);
        return;
    }

    if (cancelPreparation()) { return; }
    if (scanTypes.length === 0) {
        reject(legacyType !== undefined ? `No tuners for the type ${legacyType}` : `No tuners for the route ${route}`);
        return;
    }

    // Handle missing scan configuration
    if (!scanConfig) {
        reject(source === "dvbConf" ? "No channels in the channel config files of dvbv5 of the tuners" :
            source === "preset" ? `No channels of the preset for the route ${route}` : "Invalid scan configuration");
        return;
    }
    if (legacyType !== undefined) {
        skipCh = getLegacySkipChannels(scanConfig.channels, skipCh);
    }
    isPreparing = false;

    // Handle asynchronous scan mode
    if (asyncMode) {
        res.status(202);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.json({
            status: "accepted",
            message: "Channel scan started in async mode"
        });
        res.end();

        // Run scan in background
        runChannelScan(scanConfig, dryRun, route, refresh, null, skipCh, legacyType, byNetwork)
            .catch(error => {
                console.error("Channel scan error:", error);
                // Error is used only when the scan is stopped
                scanStatus.status = "error" as const;
                scanStatus.scanLog.push(`Error: ${String(error)}`);
                scanStatus.isScanning = false;
            });

        return;
    }

    // Synchronous mode - wait for completion
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);

    // Set longer timeout for synchronous scan mode
    req.setTimeout(1000 * 60 * 30); // 30 minutes

    try {
        // Stream output directly to response
        const logTextOutput = (textContent: string): void => {
            res.write(textContent);
        };

        // Run scan with output streaming
        await runChannelScan(scanConfig, dryRun, route, refresh, logTextOutput, skipCh, legacyType, byNetwork);
        res.end();
    } catch (error) {
        console.error("Channel scan error:", error);
        // Error is used only when the scan is stopped
        scanStatus.status = "error" as const;
        scanStatus.scanLog.push(`Error: ${String(error)}`);
        res.write(`Error during scan: ${error}\n`);
        res.end();
        scanStatus.isScanning = false;
    }
};

/**
 * API documentation for the channel scan endpoint
 */
put.apiDoc = {
    tags: ["config"],
    summary: "Channel Scan",
    description: `channels is accepted only with source=list; otherwise the request is rejected with 400. Without type, preset (the default) and dvbConf reject minCh, maxCh, minSubCh, maxSubCh and channelNameFormat with 400; use source=format and its required parameters instead.

Scans the channels of a receiving route, and decides the type of each stream by its network (original_network_id of the services):
- \`4\`: BS, \`6\` / \`7\`: CS, \`1\` / \`3\` / \`10\`: SKY, TLV (MMT): BS4K
- \`0x7880\`-\`0x7FE8\` (terrestrial): GR
- the networks of the cable television (\`0xFFF7\`, \`0xFFF9\`, \`0xFFFA\`, \`0xFFFD\`, \`0xFFFE\`, \`0xFFFF\`, such as the community channels): CATV
- The streams of the other networks are not added.

The channels to scan (\`source\`):
- \`preset\`: the channels of the route (the names of the tuner commands such as recpt1, recisdb)
    - TER: \`13\`-\`62\`
    - SAT: \`BS01_0\`-\`BS23_3\`, \`CS2\`-\`CS24\`
    - SKY: none
    - CATV: \`1\`-\`12\`, \`C13\`-\`C63\`, \`13\`-\`62\`
    - FTTH: \`13\`-\`62\`, \`BS01_0\`-\`BS23_3\`, \`CS2\`-\`CS24\`
- \`dvbConf\`: the channels of the channel config files of dvbv5-zap (\`-c\`) of the tuners used for the scan
- \`list\`: the channels of \`channels\`
- \`format\`: the channels of \`channelNameFormat\` in the range of \`minCh\`-\`maxCh\` (and \`minSubCh\`-\`maxSubCh\` with \`{subch}\`)

The tuners of the route are used. The tuners of the different types (such as ISDB-T and ISDB-S) try each channel until received (the tuners of the same types once)
(the types of the route: TER: GR, SAT: BS / CS / BS4K, SKY: SKY, CATV and FTTH: any). The remote tuners are tried by each type.
The relative streams of TSMF are detected on any local tuner.
A tuner receiving multiple systems should have all the types to receive in \`types\` (such as \`[GR, BS, CS, BS4K, CATV]\` for CATV).

Entry rewriting specifications:
- SAT・FTTHのpresetまたはdvbConfでは、BSのNITからTSでの不在を確認できたチャンネルの取得を省略し、そのチャンネルの対象経路の既存行（無効な行を含む）を置換対象として、結果保存時に削除します。refresh=falseで有効設定を引き継ぐ場合、skipChで省略した場合、取得に失敗した場合は既存行を保持します。
- The entries of the channels scanned on the route (of any type) are replaced with the result. The other entries remain.
- If an enabled entry of the channel to be scanned is in the configuration file, the scan will not be performed for that channel and the entries of the channel remain intact. If you do not want to keep the entries, use the \`refresh\` option.
- The entries added have the \`route\` if it is not the default of the type.
- The channels are unique by the type and the channel. The enabled entry of the type and the channel configured on another route remains, and the entry scanned is not added.
- \`tsmfRelTs\` is added if the type has only one relative stream of TSMF on the channel. The relative streams are detected by the service scan if more than one.
- The carriers of a TLV of multiple carriers (CATV channel bonding) are added as BS4K without the services (\`tsmfRelTs\` and \`tsmfGroupId\` are detected).

The scan by \`type\` (deprecated, compatible with 4.3.0): the channels of the type are scanned by the tuners of the type on the default route of the type (GR: TER, BS / CS: SAT),
by \`minCh\`, \`maxCh\`, \`minSubCh\`, \`maxSubCh\`, \`useSubCh\` and \`channelNameFormat\` (\`route\` and \`source\` can not be specified, \`skipCh\` also matches the numbers in the names,
only the entries of the type are replaced):
- GR: \`13\`-\`62\`
- BS: \`BS01_0\`-\`BS23_3\` (\`useSubCh\`, default), or \`101\`-\`256\`
- CS: \`CS2\`-\`CS24\``,
    operationId: "channelScan",
    produces: [
        "text/plain",
        "application/json"
    ],
    parameters: [
        {
            in: "query",
            name: "dryRun",
            type: "boolean",
            allowEmptyValue: true,
            default: false,
            description: "Dry run mode. If `true`, the scanned result will not be saved to configuration."
        },
        {
            in: "query",
            name: "route",
            type: "string",
            enum: ["TER", "SAT", "SKY", "CATV", "FTTH"] as apid.ChannelRoute[],
            // handlerで補完し、type指定時の既定経路と明示TERを区別する。
            description: "Specifies the receiving route to scan (default: TER, or the default route of type). With type, only its default route is accepted."
        },
        {
            in: "query",
            name: "type",
            type: "string",
            enum: legacyScanTypes,
            description: "Deprecated (compatible with 4.3.0): scans the channels of the type by the tuners of the type. route may be omitted or the default route of type; source may be omitted or preset."
        },
        {
            in: "query",
            name: "useSubCh",
            type: "boolean",
            allowEmptyValue: true,
            description: "従来のtype指定でのみ使用します。type=BSではtrue（省略時）でBS01_0などのサブチャンネル形式、falseで101〜256を使います。type省略時の指定は400です。source=formatでは書式に{subch}を含めてください。"
        },
        {
            in: "query",
            name: "source",
            type: "string",
            enum: ["preset", "dvbConf", "list", "format"] as ChannelScanSource[],
            default: "preset",
            description: "スキャン対象の指定方法です。typeを使わない場合、番号範囲・channelNameFormatはsource=formatでのみ指定できます。"
        },
        {
            in: "query",
            name: "channels",
            type: "array",
            items: {
                type: "string"
            },
            collectionFormat: "csv",
            description: "source=listのチャンネル識別子をカンマ区切りの1キーで指定します。4096件以下、符号化済みURL全体は8192バイト以下、クエリーのキー数は1000未満にしてください。"
        },
        {
            in: "query",
            name: "channelNameFormat",
            type: "string",
            description: "The format of the channel names (`source`: `format`). Supports placeholders like {ch}, {ch00}, {subch}. (e.g. C{ch} -> C13, BS{ch00}_{subch} -> BS01_2)"
        },
        {
            in: "query",
            name: "minCh",
            type: "integer",
            description: "The minimum number of `{ch}` (`source`: `format`)."
        },
        {
            in: "query",
            name: "maxCh",
            type: "integer",
            description: "The maximum number of `{ch}` (`source`: `format`)."
        },
        {
            in: "query",
            name: "minSubCh",
            type: "integer",
            description: "サブチャンネル番号の下限です（省略時0）。source=formatでは、書式に{subch}がない場合の指定は400です。"
        },
        {
            in: "query",
            name: "maxSubCh",
            type: "integer",
            description: "サブチャンネル番号の上限です（省略時3）。source=formatでは、書式に{subch}がない場合の指定は400です。"
        },
        {
            in: "query",
            name: "skipCh",
            type: "array",
            items: {
                type: "string"
            },
            collectionFormat: "csv",
            description: "取得を省くチャンネルをカンマ区切りの1キーで指定します。各識別子の前後の空白と空項目は除きます。4096件以下で、URL全体の8192バイト上限と1000未満のクエリーキー数にも従ってください。"
        },
        {
            in: "query",
            name: "scanMode",
            type: "string",
            enum: ["Channel", "Service"] as apid.ChannelScanMode[],
            description: "Channel scan mode. Use `Service` mode to create separate entries per service.\n\n" +
                "_Default value (GR)_: Channel\n" +
                "_Default value (the others)_: Service"
        },
        {
            in: "query",
            name: "setDisabledOnAdd",
            type: "boolean",
            allowEmptyValue: true,
            description: "`true` の場合、新たに取得したチャンネルを無効状態で追加します。ただし、サービスが未取得のTLV複数搬送波の行は、次回の受信に必要なため有効状態で追加します。\n\n" +
                "_既定値（GR）_: false\n" +
                "_既定値（GR以外）_: true"
        },
        {
            in: "query",
            name: "refresh",
            type: "boolean",
            allowEmptyValue: true,
            default: false,
            description: "If `true`, update the existing channel configurations without preserving them.\n" +
                "When false, enabled channels that already exist in the config will be preserved.\n" +
                "Note: The channels not scanned will always be preserved regardless of this setting."
        },
        {
            in: "query",
            name: "async",
            type: "boolean",
            allowEmptyValue: true,
            default: false,
            description: "If `true`, the API returns 202 Accepted immediately and performs scan asynchronously.\n" +
                "Use GET /config/channels/scan to monitor progress and retrieve the result."
        }
    ],
    responses: {
        200: {
            description: "OK - Synchronous scan completed",
            schema: {
                type: "string",
                description: "Text output of scan process"
            }
        },
        202: {
            description: "Accepted - Asynchronous scan started",
            schema: {
                type: "object",
                properties: {
                    status: {
                        type: "string",
                        enum: ["accepted"]
                    },
                    message: {
                        type: "string"
                    }
                }
            }
        },
        204: {
            description: "Cancelled before the scan was accepted"
        },
        400: {
            description: "Invalid scan configuration, no tuners for the route (or the type), or \`type\` (deprecated) specified with \`route\` or \`source\`",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        409: {
            description: "Already Scanning",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};

/**
 * Stop a channel scan in progress - API handler
 */
export const del: Operation = async (req, res) => {
    // Check if a scan is currently in progress
    if (!scanStatus.isScanning) {
        api.responseError(res, 404, "No scan in progress");
        return;
    }

    // Check if a cancellation is already requested
    if (isCancellationRequested) {
        api.responseError(res, 409, "Already Stopping");
        return;
    }

    // Set cancellation flag to true to request scan to stop
    isCancellationRequested = true;

    // while preparing, the status of the previous scan is kept (the scan stops when started, or is not started)
    if (isPreparing) {
        res.status(206);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.json({
            status: "stopping",
            message: "Channel scan stop has been requested"
        });
        return;
    }

    // Update the scan status
    scanStatus.status = "cancelled" as const;
    scanStatus.scanLog.push("Scan cancellation requested by user.");

    // Return success response
    res.status(206);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({
        status: "stopping",
        message: "Channel scan stop has been requested"
    });
};

/**
 * API documentation for the DELETE channel scan endpoint
 */
del.apiDoc = {
    tags: ["config"],
    summary: "Stop Channel Scan",
    description: "Stops a currently running channel scan operation",
    operationId: "stopChannelScan",
    produces: [
        "application/json"
    ],
    responses: {
        206: {
            description: "Accepted",
            schema: {
                type: "object",
                properties: {
                    status: {
                        type: "string",
                        enum: ["stopping"]
                    },
                    message: {
                        type: "string"
                    }
                }
            }
        },
        404: {
            description: "No scan in progress",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
