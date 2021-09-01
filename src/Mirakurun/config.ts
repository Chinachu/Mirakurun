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
import { execSync } from "child_process";
import { dirname } from "path";
import { hostname } from "os";
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as common from "./common";
import * as log from "./log";

type Writable<T> = { -readonly [K in keyof T]: T[K] };

const {
    DOCKER,
    SERVER_CONFIG_PATH,
    TUNERS_CONFIG_PATH,
    CHANNELS_CONFIG_PATH,
    HOSTNAME,
    LOG_LEVEL,
    MAX_LOG_HISTORY,
    MAX_BUFFER_BYTES_BEFORE_READY,
    EVENT_END_TIMEOUT,
    PROGRAM_GC_INTERVAL,
    EPG_GATHERING_INTERVAL,
    EPG_RETRIEVAL_TIME,
    LOGO_DATA_INTERVAL,
    DISABLE_EIT_PARSING,
    DISABLE_WEB_UI
} = process.env;

const IS_DOCKER = DOCKER === "YES";

export interface Server {
    // as Local Server
    readonly path?: string;

    // as Remote Server
    readonly port?: number;

    // hostname
    readonly hostname?: string;

    /** `true` to disable IPv6 listening */
    readonly disableIPv6?: boolean;

    readonly logLevel?: log.LogLevel;
    readonly maxLogHistory?: number;

    readonly maxBufferBytesBeforeReady?: number;
    readonly eventEndTimeout?: number;

    readonly programGCInterval?: number;
    readonly epgGatheringInterval?: number;
    readonly epgRetrievalTime?: number;
    readonly logoDataInterval?: number;
    readonly disableEITParsing?: true;
    readonly disableWebUI?: true;
}

export interface Tuner {
    readonly name: string;

    // GR / BS / CS / SKY
    readonly types: common.ChannelType[];

    // for chardev / dvb
    readonly command?: string;

    // for dvb
    readonly dvbDevicePath?: string;

    // for multiplexing w/ remote Mirakurun
    readonly remoteMirakurunHost?: string;
    readonly remoteMirakurunPort?: number;
    readonly remoteMirakurunDecoder?: boolean;

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
    readonly satellite?: string;
    readonly space?: number;
    readonly freq?: number;
    readonly polarity?: "H" | "V";

    // tsmf
    readonly tsmfRelTs?: number;

    // service id
    readonly serviceId?: number;

    readonly isDisabled?: boolean;

    /** @deprecated */
    readonly satelite?: string;
}

export function loadServer(): Server {

    const path = SERVER_CONFIG_PATH;

    // mkdir if not exists
    const dirPath = dirname(path);
    if (fs.existsSync(dirPath) === false) {
        log.info("missing directory `%s`", dirPath);
        try {
            log.info("making directory `%s`", dirPath);
            fs.mkdirSync(dirPath, { recursive: true });
        } catch (e) {
            log.fatal("failed to make directory `%s`", dirPath);
            console.error(e);
            process.exit(1);
        }
    }

    // copy if not exists
    if (fs.existsSync(path) === false) {
        log.info("missing server config `%s`", path);
        // copy if not exists
        try {
            log.info("copying default server config to `%s`", path);
            if (process.platform === "win32") {
                fs.copyFileSync("config/server.win32.yml", path);
            } else {
                fs.copyFileSync("config/server.yml", path);
            }
        } catch (e) {
            log.fatal("failed to copy server config to `%s`", path);
            console.error(e);
            process.exit(1);
        }
    }
    const config: Writable<Server> = load("server", path);

    // Docker
    if (IS_DOCKER) {
        config.path = "/var/run/mirakurun.sock";
        config.port = 40772;
        config.disableIPv6 = true;

        if (!config.hostname && typeof HOSTNAME !== "undefined" && HOSTNAME.trim().length > 0) {
            config.hostname = HOSTNAME.trim();
        }
        if (typeof LOG_LEVEL !== "undefined" && /^-?[0123]$/.test(LOG_LEVEL)) {
            config.logLevel = parseInt(LOG_LEVEL, 10);
        }
        if (typeof MAX_LOG_HISTORY !== "undefined" && /^[0-9]+$/.test(MAX_LOG_HISTORY)) {
            config.maxLogHistory = parseInt(MAX_LOG_HISTORY, 10);
        }
        if (typeof MAX_BUFFER_BYTES_BEFORE_READY !== "undefined" && /^[0-9]+$/.test(MAX_BUFFER_BYTES_BEFORE_READY)) {
            config.maxBufferBytesBeforeReady = parseInt(MAX_BUFFER_BYTES_BEFORE_READY, 10);
        }
        if (typeof EVENT_END_TIMEOUT !== "undefined" && /^[0-9]+$/.test(EVENT_END_TIMEOUT)) {
            config.eventEndTimeout = parseInt(EVENT_END_TIMEOUT, 10);
        }
        if (typeof PROGRAM_GC_INTERVAL !== "undefined" && /^[0-9]+$/.test(PROGRAM_GC_INTERVAL)) {
            config.programGCInterval = parseInt(PROGRAM_GC_INTERVAL, 10);
        }
        if (typeof EPG_GATHERING_INTERVAL !== "undefined" && /^[0-9]+$/.test(EPG_GATHERING_INTERVAL)) {
            config.epgGatheringInterval = parseInt(EPG_GATHERING_INTERVAL, 10);
        }
        if (typeof EPG_RETRIEVAL_TIME !== "undefined" && /^[0-9]+$/.test(EPG_RETRIEVAL_TIME)) {
            config.epgRetrievalTime = parseInt(EPG_RETRIEVAL_TIME, 10);
        }
        if (typeof LOGO_DATA_INTERVAL !== "undefined" && /^[0-9]+$/.test(LOGO_DATA_INTERVAL)) {
            config.logoDataInterval = parseInt(LOGO_DATA_INTERVAL, 10);
        }
        if (DISABLE_EIT_PARSING === "true") {
            config.disableEITParsing = true;
        }
        if (DISABLE_WEB_UI === "true") {
            config.disableWebUI = true;
        }

        log.info("load server config (merged w/ env): %s", JSON.stringify(config));
    }

    if (!config.hostname) {
        config.hostname = hostname();
        log.info("detected hostname: %s", config.hostname);
    }

    return config as Readonly<Server>;
}

export function saveServer(data: Server): Promise<void> {
    return save("server", SERVER_CONFIG_PATH, data);
}

export function loadTuners(): Tuner[] {

    const path = TUNERS_CONFIG_PATH;

    // mkdir if not exists
    const dirPath = dirname(path);
    if (fs.existsSync(dirPath) === false) {
        log.info("missing directory `%s`", dirPath);
        try {
            log.info("making directory `%s`", dirPath);
            fs.mkdirSync(dirPath, { recursive: true });
        } catch (e) {
            log.fatal("failed to make directory `%s`", dirPath);
            console.error(e);
            process.exit(1);
        }
    }

    // auto
    if (process.platform === "linux" && fs.existsSync(path) === false) {
        log.info("missing tuners config `%s`", path);
        log.info("trying to detect tuners...");
        const tuners: Tuner[] = [];

        // detect dvbdev
        try {
            execSync("which dvb-fe-tool");

            const adapters = fs.readdirSync("/dev/dvb").filter(name => /^adapter[0-9]+$/.test(name));
            for (let i = 0; i < adapters.length; i++) {
                log.info("detected DVB device: %s", adapters[i]);

                execSync("sleep 1");
                const properties = execSync(`dvb-fe-tool -a ${i} 2>&1 || true`, { encoding: "utf8" });
                const isISDBT = properties.includes("[ISDBT]");
                const isISDBS = properties.includes("[ISDBS]");
                if (!isISDBT && !isISDBS) {
                    continue;
                }

                const tuner: Writable<Tuner> = {
                    name: adapters[i],
                    types: undefined,
                    dvbDevicePath: `/dev/dvb/adapter${i}/dvr0`,
                    decoder: "arib-b25-stream-test"
                };

                if (isISDBT) {
                    tuner.types = ["GR"];
                    tuner.command = `dvbv5-zap -a ${i} -c ./config/dvbconf-for-isdb/conf/dvbv5_channels_isdbt.conf -r -P <channel>`;
                } else if (isISDBS) {
                    tuner.types = ["BS", "CS"];
                    tuner.command = `dvbv5-zap -a ${i} -c ./config/dvbconf-for-isdb/conf/dvbv5_channels_isdbs.conf -r -P <channel>`;
                }

                tuners.push(tuner);

                log.info("added tuner config (generated): %s", JSON.stringify(tuner));
            }
        } catch (e) {
            if (/which dvb-fe-tool/.test(e.message)) {
                log.warn("`dvb-fe-tool` is required to detect DVB devices. (%s)", e.message);
            } else {
                console.error(e);
            }
        }

        log.info("detected %d tuners!", tuners.length);

        if (tuners.length > 0) {
            try {
                log.info("writing auto generated tuners config to `%s`", path);
                fs.writeFileSync(path, yaml.dump(tuners));
            } catch (e) {
                log.fatal("failed to write tuners config to `%s`", path);
                console.error(e);
                process.exit(1);
            }
        }
    }

    // copy if not exists
    if (fs.existsSync(path) === false) {
        log.info("missing tuners config `%s`", path);
        try {
            log.info("copying default tuners config to `%s`", path);
            if (process.platform === "win32") {
                fs.copyFileSync("config/tuners.win32.yml", path);
            } else {
                fs.copyFileSync("config/tuners.yml", path);
            }
        } catch (e) {
            log.fatal("failed to copy tuners config to `%s`", path);
            console.error(e);
            process.exit(1);
        }
    }

    return load("tuners", path);
}

export function saveTuners(data: Tuner[]): Promise<void> {
    return save("tuners", TUNERS_CONFIG_PATH, data);
}

export function loadChannels(): Channel[] {

    const path = CHANNELS_CONFIG_PATH;

    // mkdir if not exists
    const dirPath = dirname(path);
    if (fs.existsSync(dirPath) === false) {
        log.info("missing directory `%s`", dirPath);
        try {
            log.info("making directory `%s`", dirPath);
            fs.mkdirSync(dirPath, { recursive: true });
        } catch (e) {
            log.fatal("failed to make directory `%s`", dirPath);
            console.error(e);
            process.exit(1);
        }
    }

    // copy if not exists
    if (fs.existsSync(path) === false) {
        log.info("missing channels config `%s`", path);
        try {
            log.info("copying default channels config to `%s`", path);
            if (process.platform === "win32") {
                fs.copyFileSync("config/channels.win32.yml", path);
            } else {
                fs.copyFileSync("config/channels.yml", path);
            }
        } catch (e) {
            log.fatal("failed to copy channels config to `%s`", path);
            console.error(e);
            process.exit(1);
        }
    }

    return load("channels", path);
}

export function saveChannels(data: Channel[]): Promise<void> {
    return save("channels", CHANNELS_CONFIG_PATH, data);
}

function load(name: "server", path: string): Server;
function load(name: "tuners", path: string): Tuner[];
function load(name: "channels", path: string): Channel[];
function load(name: string, path: string) {

    log.info("load %s config `%s`", name, path);

    return yaml.load(fs.readFileSync(path, "utf8"));
}

function save(name: "server", path: string, data: Server): Promise<void>;
function save(name: "tuners", path: string, data: Tuner[]): Promise<void>;
function save(name: "channels", path: string, data: Channel[]): Promise<void>;
function save(name: string, path: string, data: object): Promise<void> {

    log.info("save %s config `%s`", name, path);

    return new Promise<void>((resolve, reject) => {

        fs.writeFile(path, yaml.dump(data), err => {

            if (err) {
                return reject(err);
            }

            resolve();
        });
    });
}
