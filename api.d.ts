/*
   Copyright 2016 Yuki KAN

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
    satelite?: string;
    services?: Service[];
}

export type ChannelType = "GR" | "BS" | "CS" | "SKY";

export interface Service {
    id: ServiceItemId;
    serviceId: ServiceId;
    networkId: NetworkId;
    name: string;
    logoId?: number;
    hasLogoData?: boolean;
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
    audio?: {
        samplingRate: ProgramAudioSamplingRate;
        componentType: number;
    }

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

export interface ProgramRelatedItem {
    networkId?: number;
    serviceId: number;
    eventId: number;
}

export interface TunerDevice {
    index: number;
    name: string;
    types: ChannelType;
    command: string;
    pid: number;
    users: TunerUser[];
    isAvailable: boolean;
    isFree: boolean;
    isUsing: boolean;
}

export interface TunerUser {
    id: string;
    priority: number;
    agent?: string;
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
    logLevel?: LogLevel;
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
    name: string;
    types: ChannelType[];
    /** for chardev / dvb */
    command?: string;
    /** for dvb */
    dvbDevicePath?: string;
    decoder?: string;
    isDisabled?: boolean;
}

export type ConfigChannels = ConfigChannelsItem[];

export interface ConfigChannelsItem {
    name: string;
    type: ChannelType;
    /** passed to tuning command */
    channel: string;
    satelite?: string;
    serviceId?: number;
    isDisabled?: boolean;
}

export interface Version {
    current: string;
    latest: string;
}

export interface Status {
    version: string;
    process: {
        arch: string;
        platform: string;
        versions: any;
        pid: number;
        memoryUsage: NodeJS.MemoryUsage;
    };
    epg: {
        gatheringNetworks: NetworkId[];
        storedEvents: number;
    };
    streamCount: {
        tunerDevice: number;
        tsFilter: number;
        decoder: number;
    };
    errorCount: {
        uncaughtException: number;
        bufferOverflow: number;
        tunerDeviceRespawn: number;
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