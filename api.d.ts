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

export interface Error {
    code?: number;
    reason?: string;
    errors?: ErrorOfOpenAPI[];
}

export interface ErrorOfOpenAPI {
    errorCode?: string;
    message?: string;
    location?: string;
}

export type ProgramId = number;

export type EventId = number;

export type ServiceId = number;

export type NetworkId = number;

export type ServiceItemId = number;

export type UnixtimeMS = number;

export interface Channel {
    type: ChannelType;
    channel: string;
    name?: string;
    /** receiving route. (default: `TER` for `GR`, `SAT` for others) */
    route?: ChannelRoute;
    services?: Service[];
}

export type ChannelType = "GR" | "BS" | "CS" | "SKY" | "BS4K";

/** `tlv` for the channels of TLV (MMT), such as `BS4K`. */
export type StreamFormat = "ts" | "tlv";

/** how the tuner receives the channel. e.g. `CATV` for BS/CS via transmodulation. */
export type ChannelRoute = "TER" | "SAT" | "CATV" | "HIKARI";

export interface Service {
    /** Relative TS on the carrier, when returned in Channel.services. */
    tsmfRelTs?: number;
    id: ServiceItemId;
    serviceId: ServiceId;
    networkId: NetworkId;
    name: string;
    type: number;
    logoId?: number;
    hasLogoData?: boolean;
    remoteControlKeyId?: number;
    epgReady?: boolean;
    epgUpdatedAt?: number;
    /** transport_stream_id of the stream carrying the service. */
    streamId?: number;
    channel?: Channel;
    /** every channel carrying the stream of the service. */
    channels?: Channel[];
}

export interface Program {
    id: ProgramId;
    eventId: EventId;
    serviceId: ServiceId;
    networkId: NetworkId;
    startAt: UnixtimeMS;
    duration: number;
    isFree: boolean;

    name?: string;
    description?: string;
    genres?: ProgramGenre[];
    video?: ProgramVideo;
    /** Video metadata carried by MH-EIT (MMT). */
    mmtVideo?: ProgramMMTVideo;
    audios?: ProgramAudio[];

    series?: ProgramSeries;

    extended?: {
        [description: string]: string;
    };

    relatedItems?: ProgramRelatedItem[];
}

export interface ProgramGenre {
    lv1: number;
    lv2: number;
    un1: number;
    un2: number;
}

export interface ProgramVideo {
    type: ProgramVideoType;
    resolution: ProgramVideoResolution;
    streamContent: number;
    componentType: number;
}

export interface ProgramMMTVideo {
    resolution: ProgramVideoResolution | null;
    frameRate?: ProgramVideoFrameRate;
    transferCharacteristics?: ProgramVideoTransferCharacteristics;
}

export type ProgramVideoType = "mpeg2" | "h.264" | "h.265";

/** ARIB STD-B60 Table 7-50 */
export type ProgramVideoFrameRate = "15" | "23.976" | "24" | "25" | "29.97" | "30" | "50" | "59.94" | "60" | "100" | "119.88" | "120";

/** ARIB STD-B60 Table 7-51 */
export type ProgramVideoTransferCharacteristics = "bt709" | "iec61966" | "bt2020" | "bt2100-pq" | "bt2100-hlg";

export type ProgramVideoResolution = (
    "240p" |
    "480i" |
    "480p" |
    "720p" |
    "1080i" |
    "1080p" |
    "2160p" |
    "4320p"
);

export interface ProgramAudio {
    /** component_type
     * - 0x01 - 1/0 mode (single-mono)
     * - 0x02 - 1/0 + 1/0 mode (dual-mono)
     * - 0x03 - 2/0 mode (stereo)
     * - 0x07 - 3/1 mode
     * - 0x08 - 3/2 mode
     * - 0x09 - 3/2 + LFE mode
     */
    componentType: number;
    componentTag: number;
    isMain: boolean;
    samplingRate: ProgramAudioSamplingRate;
    /** ISO_639_language_code, ISO_639_language_code_2
     * - this `#length` will `2` if dual-mono multi-lingual.
     */
    langs: ProgramAudioLanguageCode[];
}

export type ProgramAudioSamplingRate = (
    16000 |
    22050 |
    24000 |
    32000 |
    44100 |
    48000
);

export type ProgramAudioLanguageCode = (
    "jpn" |
    "eng" |
    "deu" |
    "fra" |
    "ita" |
    "rus" |
    "zho" |
    "kor" |
    "spa" |
    "etc"
);

export interface ProgramSeries {
    id: number;
    repeat: number;
    pattern: number;
    expiresAt: number;
    episode: number;
    lastEpisode: number;
    name: string;
}

export type ProgramRelatedItemType = "shared" | "relay" | "movement";

export interface ProgramRelatedItem {
    type: ProgramRelatedItemType;
    networkId?: number;
    serviceId: number;
    eventId: number;
}

export interface TunerDevice {
    index: number;
    name: string;
    types: ChannelType[];
    routes?: ChannelRoute[];
    command: string;
    /** `null` when no process is running (including when the tuner accesses the DVB device directly). */
    pid: number | null;
    users: TunerUser[];
    isAvailable: boolean;
    isRemote: boolean;
    isFree: boolean;
    isUsing: boolean;
    isFault: boolean;
}

export interface TunerUser {
    id: string;
    priority: number;
    agent?: string;
    url?: string;
    disableDecoder?: boolean;
    streamSetting?: StreamSetting;
    streamInfo?: StreamInfo;
}

interface StreamSetting {
    channel: ConfigChannelsItem;
    networkId?: number;
    serviceId?: number;
    eventId?: number;
    noProvide?: boolean;
    parseNIT?: boolean;
    parseSDT?: boolean;
    parseEIT?: boolean;
    /** the relative stream of TSMF */
    tsmfRelTs?: number;
}

export interface StreamInfo {
    [PID: string]: {
        packet: number;
        drop: number;
    }
}

export interface TunerProcess {
    /** `null` when the tuner accesses the DVB device directly (no process). */
    pid: number | null;
}

export interface JobScheduleItem {
    key: string;
    schedule: string;
    job: Pick<JobItem, "key" | "name">;
}

export interface JobItem {
    key: string;
    name: string;
    id: string;
    status: "queued" | "standby" | "running" | "finished";
    retryCount: number;

    isRerunnable?: boolean;
    retryOnAbort?: boolean;
    retryOnFail?: boolean;
    retryMax?: number;
    retryDelay?: number;

    isAborting: boolean;
    hasAborted?: boolean;
    hasSkipped?: boolean;
    hasFailed?: boolean;
    error?: string;

    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    finishedAt?: number;
    duration?: number;
}

export interface Event<T = any> {
    resource: EventResource;
    type: EventType;
    data: T;
    time: UnixtimeMS;
}

export type EventResource = "program" | "service" | "tuner" | "job" | "job_schedule";

export type EventType = "create" | "update" | "remove";

export interface ConfigServer {
    path?: string;
    port?: number;
    hostname?: string;
    disableIPv6?: boolean;
    logLevel?: LogLevel;
    maxLogHistory?: number;
    jobMaxRunning?: number;
    jobMaxStandby?: number;
    maxBufferBytesBeforeReady?: number;
    eventEndTimeout?: number;
    programGCJobSchedule?: string;
    epgGatheringJobSchedule?: string;
    epgRetrievalTime?: number;
    logoDataInterval?: number;
    disableEITParsing?: boolean;
    disableWebUI?: boolean;
    allowIPv4CidrRanges?: string[];
    allowIPv6CidrRanges?: string[];
    allowOrigins: string[];
    allowPNA: boolean;
    tsplayEndpoint: string;
    /** the output format of the TLV (MMT) channels for the stream requests without `format`. (default: `tlv`) */
    defaultTlvStreamFormat?: StreamFormat;
}

/**
 * FATAL: -1
 * ERROR: 0
 * WARN: 1
 * INFO: 2
 * DEBUG: 3
 */
export type LogLevel = -1 | 0 | 1 | 2 | 3;

export type ConfigTuners = ConfigTunersItem[];

export interface ConfigTunersItem {
    /** tuner name for identifying. */
    name: string;
    /** channel type. */
    types: ChannelType[];
    /** receiving routes. (default: all routes) */
    routes?: ChannelRoute[];
    /** [chardev][dvb] command to get TS. */
    command?: string;
    /** [dvb] dvr adapter device path */
    dvbDevicePath?: string;
    /** [dvb] `true` to run the dvbv5-zap command instead of accessing the DVB device directly. */
    disableDvbDirect?: boolean;
    /** [remote] specify to use remote Mirakurun host like as `192.168.1.x`. */
    remoteMirakurunHost?: string;
    /** [remote] specify to use remote Mirakurun port number (default: 40772). */
    remoteMirakurunPort?: number;
    /** [remote] `true` to use remote decoder. `false` to use local decoder. (if decoder specified) */
    remoteMirakurunDecoder?: boolean;
    /** CAS processor command if needed. */
    decoder?: string;
    /** [TLV] CAS processor command for TLV (input and output TLV) if needed. */
    tlvDecoder?: string;
    /** [TLV] command to convert TLV to MPEG-2 TS. */
    tlvToTsDecoder?: string;
    /** `true` to **disable** this tuner. */
    isDisabled?: boolean;
}

export type ConfigChannels = ConfigChannelsItem[];

export interface ConfigChannelsItem {
    name: string;
    type: ChannelType;
    /** passed to tuning command */
    channel: string;
    /** receiving route. (default: `TER` for `GR`, `SAT` for others) */
    route?: ChannelRoute;
    serviceId?: number;
    /** TSMF (MPEG-TS Multi Frame) relative TS number config for CATV */
    tsmfRelTs?: number;
    /** `tlv` for TLV (MMT). (default: detected by the service scan, or `tlv` for `BS4K`) */
    format?: StreamFormat;
    /** [TLV] the channels of the same `tsmfGroupId` and type are the bonded carriers (channel bonding of CATV) */
    tsmfGroupId?: number;
    /**
     * passed to tuning command variables.
     * @example { "freq": 123456, "polarity": "H", "space": 6, "extra-args": "..." }
     */
    commandVars?: Record<string, string | number>;
    isDisabled?: boolean;
    /** @deprecated typo of "satellite". */
    readonly satelite?: string;
    /** @deprecated from 4.0.0, use `commandVars` instead. */
    readonly satellite?: string;
    /** @deprecated from 4.0.0, use `commandVars` instead. */
    readonly space?: number;
    /** @deprecated from 4.0.0, use `commandVars` instead. */
    readonly freq?: number;
    /** @deprecated from 4.0.0, use `commandVars` instead. */
    readonly polarity?: "H" | "V";
}

export interface ChannelScanStatus {
    isScanning: boolean;
    status: ChannelScanPhase;
    route?: ChannelRoute;
    dryRun?: boolean;
    progress?: number;
    currentChannel?: string;
    scanLog?: string[];
    newCount?: number;
    takeoverCount?: number;
    result?: ConfigChannelsItem[];
    startTime?: number;
    updateTime?: number;
}

export type ChannelScanMode = "Channel" | "Service";

/** the channels to scan */
export type ChannelScanSource = "preset" | "dvbConf" | "list" | "format";

export type ChannelScanPhase = (
    "not_started" |
    "scanning" |
    "completed" |
    "cancelled" |
    "error"
);

export type ChannelScanStep = (
    "started" |
    "scanning_channel" |
    "takeover" |
    "skipped" |
    "services_found" |
    "channels_found" |
    "error"
);

export type ChannelScanResultType = (
    "summary" |
    "summary_new" |
    "summary_takeover" |
    "restart_required" |
    "final_result"
);

export interface Version {
    current: string;
    latest: string;
}

export interface Status {
    time: number;
    version: string;
    process: {
        arch: string;
        platform: string;
        versions: any;
        env: any;
        pid: number;
        memoryUsage: NodeJS.MemoryUsage;
    };
    epg: {
        gatheringNetworks: NetworkId[];
        storedEvents: number;
    };
    rpcCount: number;
    streamCount: {
        tunerDevice: number;
        tsFilter: number;
        decoder: number;
    };
    errorCount: {
        uncaughtException: number;
        unhandledRejection: number;
        bufferOverflow: number;
        tunerDeviceRespawn: number;
        decoderRespawn: number;
    };
    timerAccuracy: {
        last: number;
        m1: {
            avg: number;
            min: number;
            max: number;
        };
        m5: {
            avg: number;
            min: number;
            max: number;
        };
        m15: {
            avg: number;
            min: number;
            max: number;
        };
    };
}
