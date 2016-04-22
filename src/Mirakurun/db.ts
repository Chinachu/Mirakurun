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
/// <reference path="../../typings/node/node.d.ts" />
'use strict';

import * as fs from 'fs';
import * as common from './common';
import * as log from './log';

module db {

    export interface Service {
        id: number;
        serviceId: number;
        networkId: number;
        name: string;
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
        //attributes: string[];
        video?: ProgramVideo;
        audio?: ProgramAudio;

        extended?: {
            text: string;
        }

        //series?: ProgramSeries;

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

    export type ProgramVideoType = "mpeg2" | "h.264" | "h.265"

    export type ProgramVideoResolution = (
        "240p" | "480i" | "480p" | "720p" |
        "1080i" | "1080p" | "2160p" | "4320p"
    )

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

    /* export interface ProgramSeries {
        id: number;
        repeatCount: number;
        pattern: number;
        expiresAt: number;
        lastEpisode: number;
        name: string;
    } */

    export interface ProgramRelatedItem {
        networkId?: number;
        serviceId: number;
        eventId: number;
    }

    export function loadServices(): Service[] {
        return load(process.env.SERVICES_DB_PATH);
    }

    export function saveServices(data: Service[]): Promise<void> {
        return save(process.env.SERVICES_DB_PATH, data);
    }

    export function loadPrograms(): Program[] {
        return load(process.env.PROGRAMS_DB_PATH);
    }

    export function savePrograms(data: Program[]): Promise<void> {
        return save(process.env.PROGRAMS_DB_PATH, data);
    }

    function load(path) {

        log.debug('load db `%s`', path);

        if (fs.existsSync(path) === true) {
            return require(path);
        } else {
            return [];
        }
    }

    function save(path: string, data: any[]): Promise<void> {

        log.debug('save db `%s`', path);

        return new Promise<void>((resolve, reject) => {

            fs.writeFile(path, JSON.stringify(data), err => {

                if (err) {
                    return reject(err);
                }

                delete require.cache[require.resolve(path)];

                resolve();
            });
        });
    }
}

export default db;