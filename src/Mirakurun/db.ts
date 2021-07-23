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
import { dirname } from "path";
import * as fs from "fs";
import * as common from "./common";
import * as log from "./log";

export interface Service {
    id: number;
    serviceId: number;
    networkId: number;
    name: string;
    type: number;
    hasLogoData?: boolean;
    logoId: number;
    logoData?: string; // base64
    remoteControlKeyId?: number;
    channel: Channel;
}

export interface Channel {
    type: common.ChannelType;
    channel: string;
}

export interface Program {
    id?: number;
    eventId?: number;
    serviceId?: number;
    networkId?: number;
    startAt?: number;
    duration?: number;
    isFree?: boolean;

    name?: string;
    description?: string;
    genres?: ProgramGenre[];
    video?: ProgramVideo;
    audio?: ProgramAudio;

    extended?: {
        [description: string]: string;
    };

    series?: ProgramSeries;

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
    resolution: string;

    streamContent: number;
    componentType: number;
}

export type ProgramVideoType = "mpeg2" | "h.264" | "h.265";

export type ProgramVideoResolution = (
    "240p" | "480i" | "480p" | "720p" |
    "1080i" | "1080p" | "2160p" | "4320p"
);

export interface ProgramAudio {
    samplingRate: ProgramAudioSamplingRate;

    componentType: number;
}

export enum ProgramAudioSamplingRate {
    "16kHz" = 16000,
    "22.05kHz" = 22050,
    "24kHz" = 24000,
    "32kHz" = 32000,
    "44.1kHz" = 44100,
    "48kHz" = 48000
}

export interface ProgramSeries {
    id: number;
    repeat: number;
    pattern: number;
    expiresAt: number;
    episode: number;
    lastEpisode: number;
    name: string;
}

export interface ProgramRelatedItem {
    networkId?: number;
    serviceId: number;
    eventId: number;
}

export function loadServices(integrity: string): Service[] {
    return load(process.env.SERVICES_DB_PATH, integrity);
}

export function saveServices(data: Service[], integrity: string): Promise<void> {
    return save(process.env.SERVICES_DB_PATH, data, integrity);
}

export function loadPrograms(integrity: string): Program[] {
    return load(process.env.PROGRAMS_DB_PATH, integrity);
}

export function savePrograms(data: Program[], integrity: string): Promise<void> {
    return save(process.env.PROGRAMS_DB_PATH, data, integrity);
}

function load(path: string, integrity: string) {

    log.info("load db `%s` w/ integrity (%s)", path, integrity);

    if (fs.existsSync(path) === true) {
        const json = fs.readFileSync(path, "utf8");
        try {
            const array: any[] = JSON.parse(json);
            if (array.length > 0 && array[0].__integrity__) {
                if (integrity === array[0].__integrity__) {
                    return array.slice(1);
                } else {
                    log.warn("db `%s` integrity check has failed", path);
                    return [];
                }
            }
            return array;
        } catch (e) {
            log.error("db `%s` is broken (%s: %s)", path, e.name, e.message);
            return [];
        }
    } else {
        log.info("db `%s` is not exists", path);
        return [];
    }
}

function save(path: string, data: any[], integrity: string): Promise<void> {

    log.info("save db `%s` w/ integirty (%s)", path, integrity);

    data.unshift({ __integrity__: integrity });

    return new Promise<void>((resolve, reject) => {

        // mkdir if not exists
        const dirPath = dirname(path);
        if (fs.existsSync(dirPath) === false) {
            try {
                fs.mkdirSync(dirPath, { recursive: true });
            } catch (e) {
                return reject(e);
            }
        }

        fs.writeFile(path, JSON.stringify(data), err => {

            if (err) {
                return reject(err);
            }

            resolve();
        });
    });
}
