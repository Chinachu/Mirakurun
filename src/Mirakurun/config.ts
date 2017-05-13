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
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as common from "./common";
import * as log from "./log";

export interface Server {
    // as Local Server
    readonly path?: string;

    // as Remote Server
    readonly port?: number;

    /** `true` to disable IPv6 listening */
    readonly disableIPv6?: boolean;

    readonly logLevel?: log.LogLevel;
    readonly maxLogHistory?: number;

    /** Byte */
    readonly highWaterMark?: number;
    /** Milliseconds */
    readonly overflowTimeLimit?: number;
    readonly maxBufferBytesBeforeReady?: number;
    readonly eventEndTimeout?: number;

    readonly programGCInterval?: number;
    readonly epgGatheringInterval?: number;
    readonly epgRetrievalTime?: number;
}

export interface Tuner {
    readonly name: string;

    // GR / BS / CS / SKY
    readonly types: common.ChannelType[];

    // for chardev / dvb
    readonly command?: string;

    // for dvb
    readonly dvbDevicePath?: string;

    // decoder
    readonly decoder?: string;

    readonly isDisabled?: boolean;
}

export interface Channel {
    readonly name: string;

    // GR / BS / CS / SKY
    readonly type: common.ChannelType;

    // passed to tuning command
    readonly channel: string;
    readonly satelite?: string;
    readonly space?: number;

    // service id
    readonly serviceId?: number;

    readonly isDisabled?: boolean;
}

export function loadServer(): Server {
    return load(process.env.SERVER_CONFIG_PATH);
}

export function saveServer(data: Server): Promise<void> {
    return save(process.env.SERVER_CONFIG_PATH, data);
}

export function loadTuners(): Tuner[] {
    return load(process.env.TUNERS_CONFIG_PATH);
}

export function saveTuners(data: Tuner[]): Promise<void> {
    return save(process.env.TUNERS_CONFIG_PATH, data);
}

export function loadChannels(): Channel[] {
    return load(process.env.CHANNELS_CONFIG_PATH);
}

export function saveChannels(data: Channel[]): Promise<void> {
    return save(process.env.CHANNELS_CONFIG_PATH, data);
}

function load(path: string) {

    log.info("load config `%s`", path);

    return yaml.safeLoad(fs.readFileSync(path, "utf8"));
}

function save(path: string, data: object): Promise<void> {

    log.info("save config `%s`", path);

    return new Promise<void>((resolve, reject) => {

        fs.writeFile(path, yaml.safeDump(data), err => {

            if (err) {
                return reject(err);
            }

            resolve();
        });
    });
}
