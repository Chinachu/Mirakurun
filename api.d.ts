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
    satellite?: string;
    space?: number;
    freq?: number;
    polarity?: "H" | "V";
    services?: Service[];
}

export type ChannelType = "GR" | "BS" | "CS" | "SKY";

export type ChannelScanMode = "Channel" | "Service";

export interface Service {
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
    channel?: Channel;
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
    video?: {
        type: ProgramVideoType;
        resolution: ProgramVideoResolution;
        streamContent: number;
        componentType: number;
    }
    audios?: {
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
    }[]

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

export type ProgramVideoType = "mpeg2" | "h.264" | "h.265";

export type ProgramVideoResolution = "240p" | "480i" | "480p" | "720p" | "1080i" | "2160p" | "4320p";

export enum ProgramAudioSamplingRate {
    "16kHz" = 16000,
    "22.05kHz" = 22050,
    "24kHz" = 24000,
    "32kHz" = 32000,
    "44.1kHz" = 44100,
    "48kHz" = 48000
}

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
    command: string;
    pid: number;
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
}

export interface StreamInfo {
    [PID: string]: {
        packet: number;
        drop: number;
    }
}

export interface TunerProcess {
    pid: number;
}

export interface Event {
    resource: EventResource;
    type: EventType;
    data: any;
    time: UnixtimeMS;
}

export type EventResource = "program" | "service" | "tuner";

export type EventType = "create" | "update" | "redefine";

export interface ConfigServer {
    path?: string;
    port?: number;
    hostname?: string;
    disableIPv6?: boolean;
    logLevel?: LogLevel;
    maxLogHistory?: number;
    maxBufferBytesBeforeReady?: number;
    eventEndTimeout?: number;
    programGCInterval?: number;
    epgGatheringInterval?: number;
    epgRetrievalTime?: number;
    logoDataInterval?: number;
    disableEITParsing?: boolean;
}

export enum LogLevel {
    "FATAL" = -1,
    "ERROR" = 0,
    "WARN" = 1,
    "INFO" = 2,
    "DEBUG" = 3
}

export type ConfigTuners = ConfigTunersItem[];

export interface ConfigTunersItem {
    /** tuner name for identifying. */
    name: string;
    /** channel type. */
    types: ChannelType[];
    /** [chardev][dvb] command to get TS. */
    command?: string;
    /** [dvb] dvr adapter device path */
    dvbDevicePath?: string;
    /** [remote] specify to use remote Mirakurun host like as `192.168.1.x`. */
    remoteMirakurunHost?: string;
    /** [remote] specify to use remote Mirakurun port number (default: 40772). */
    remoteMirakurunPort?: number;
    /** [remote] `true` to use remote decoder. `false` to use local decoder. (if decoder specified) */
    remoteMirakurunDecoder?: boolean;
    /** CAS processor command if needed. */
    decoder?: string;
    /** `true` to **disable** this tuner. */
    isDisabled?: boolean;
}

export type ConfigChannels = ConfigChannelsItem[];

export interface ConfigChannelsItem {
    name: string;
    type: ChannelType;
    /** passed to tuning command */
    channel: string;
    satellite?: string;
    serviceId?: number;
    space?: number;
    freq?: number;
    polarity?: "H" | "V";
    tsmfRelTs?: number;
    isDisabled?: boolean;
}

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
