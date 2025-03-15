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
import { existsSync, readdirSync } from "fs";
import { mkdir, copyFile, readFile, writeFile } from "fs/promises";
import * as yaml from "js-yaml";
import * as ipnum from "ip-num";
import Queue from "promise-queue";
import * as apid from "../../api";
import * as log from "./log";

type Writable<T> = { -readonly [K in keyof T]: T[K] };

const {
    DOCKER,
    DOCKER_NETWORK,
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
    DISABLE_WEB_UI,
    ALLOW_IPV4_CIDR_RANGES,
    ALLOW_IPV6_CIDR_RANGES,
    ALLOW_ORIGINS,
    ALLOW_PNA,
    TSPLAY_ENDPOINT
} = process.env;

const IS_DOCKER = DOCKER === "YES";

type Server = Readonly<apid.ConfigServer>;
type Tuner = Readonly<apid.ConfigTunersItem>;
type Channel = Readonly<apid.ConfigChannelsItem>;

export async function loadServer(): Promise<Server> {
    const path = SERVER_CONFIG_PATH;

    // mkdir if not exists
    const dirPath = dirname(path);
    if (existsSync(dirPath) === false) {
        log.info("missing directory `%s`", dirPath);
        try {
            log.info("making directory `%s`", dirPath);
            await mkdir(dirPath, { recursive: true });
        } catch (e) {
            log.fatal("failed to make directory `%s`", dirPath);
            console.error(e);
            process.exit(1);
        }
    }

    // copy if not exists
    if (existsSync(path) === false) {
        log.info("missing server config `%s`", path);
        // copy if not exists
        try {
            log.info("copying default server config to `%s`", path);
            await copyFile("config/server.yml", path);
        } catch (e) {
            log.fatal("failed to copy server config to `%s`", path);
            console.error(e);
            process.exit(1);
        }
    }
    const config: Writable<Server> = await load("server", path);

    // set default
    if (!config.allowIPv4CidrRanges) {
        config.allowIPv4CidrRanges = ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
    }
    if (!config.allowIPv6CidrRanges) {
        config.allowIPv6CidrRanges = ["fc00::/7"];
    }
    if (!config.allowOrigins) {
        config.allowOrigins = [
            "https://mirakurun-secure-contexts-api.pages.dev"
        ];
    }
    if (!config.allowPNA) {
        config.allowPNA = true;
    }
    if (!config.tsplayEndpoint) {
        config.tsplayEndpoint = "https://mirakurun-secure-contexts-api.pages.dev/tsplay/";
    }

    // Docker
    if (IS_DOCKER) {
        config.path = "/var/run/mirakurun.sock";
        if (DOCKER_NETWORK !== "host") {
            config.port = 40772;
            config.disableIPv6 = true;
        }

        if (!config.hostname && typeof HOSTNAME !== "undefined" && HOSTNAME.trim().length > 0) {
            config.hostname = HOSTNAME.trim();
        }
        if (typeof LOG_LEVEL !== "undefined" && /^-?[0123]$/.test(LOG_LEVEL)) {
            config.logLevel = parseInt(LOG_LEVEL, 10) as apid.LogLevel;
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
        if (typeof ALLOW_IPV4_CIDR_RANGES !== "undefined" && ALLOW_IPV4_CIDR_RANGES.trim().length > 0) {
            config.allowIPv4CidrRanges = ALLOW_IPV4_CIDR_RANGES.split(",");
        }
        if (typeof ALLOW_IPV6_CIDR_RANGES !== "undefined" && ALLOW_IPV6_CIDR_RANGES.trim().length > 0) {
            config.allowIPv6CidrRanges = ALLOW_IPV6_CIDR_RANGES.split(",");
        }
        if (typeof ALLOW_ORIGINS !== "undefined" && ALLOW_ORIGINS.trim().length > 0) {
            config.allowOrigins = ALLOW_ORIGINS.split(",");
        }
        if (ALLOW_PNA === "true") {
            config.allowPNA = true;
        } else if (ALLOW_PNA === "false") {
            config.allowPNA = false;
        }
        if (typeof TSPLAY_ENDPOINT !== "undefined" && TSPLAY_ENDPOINT.trim().length > 0) {
            config.tsplayEndpoint = TSPLAY_ENDPOINT.trim();
        }

        log.info("load server config (merged w/ env): %s", JSON.stringify(config));
    }

    if (!config.hostname) {
        config.hostname = hostname();
        log.info("detected hostname: %s", config.hostname);
    }

    // validate allowIPv4CidrRanges
    {
        const validRanges: string[] = [];

        for (const range of config.allowIPv4CidrRanges) {
            const [valid, errors] = ipnum.Validator.isValidIPv4CidrRange(range);
            if (valid) {
                validRanges.push(range);
                continue;
            }
            for (const error of errors) {
                log.error("invalid server config property `allowIPv4CidrRanges`: %s - %s", range, error);
            }
        }

        config.allowIPv4CidrRanges = validRanges;
    }

    // validate allowIPv6CidrRanges
    {
        const validRanges: string[] = [];

        for (const range of config.allowIPv6CidrRanges) {
            const [valid, errors] = ipnum.Validator.isValidIPv6CidrRange(range);
            if (valid) {
                validRanges.push(range);
                continue;
            }
            for (const error of errors) {
                log.error("invalid server config property `allowIPv6CidrRanges`: %s - %s", range, error);
            }
        }

        config.allowIPv6CidrRanges = validRanges;
    }

    return config as Readonly<Server>;
}

export function saveServer(data: Server): Promise<void> {
    return save("server", SERVER_CONFIG_PATH, data);
}

export async function loadTuners(): Promise<Tuner[]> {
    const path = TUNERS_CONFIG_PATH;

    // mkdir if not exists
    const dirPath = dirname(path);
    if (existsSync(dirPath) === false) {
        log.info("missing directory `%s`", dirPath);
        try {
            log.info("making directory `%s`", dirPath);
            await mkdir(dirPath, { recursive: true });
        } catch (e) {
            log.fatal("failed to make directory `%s`", dirPath);
            console.error(e);
            process.exit(1);
        }
    }

    // auto
    if (existsSync(path) === false) {
        log.info("missing tuners config `%s`", path);
        log.info("trying to detect tuners...");
        const tuners: Tuner[] = [];

        // detect dvbdev
        try {
            execSync("which dvb-fe-tool");

            const adapters = readdirSync("/dev/dvb").filter(name => /^adapter[0-9]+$/.test(name));
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
                await saveTuners(tuners);
            } catch (e) {
                log.fatal("failed to write tuners config to `%s`", path);
                console.error(e);
                process.exit(1);
            }
        }
    }

    // copy if not exists
    if (existsSync(path) === false) {
        log.info("missing tuners config `%s`", path);
        try {
            log.info("copying default tuners config to `%s`", path);
            await copyFile("config/tuners.yml", path);
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

export async function loadChannels(): Promise<Channel[]> {
    const path = CHANNELS_CONFIG_PATH;

    // mkdir if not exists
    const dirPath = dirname(path);
    if (existsSync(dirPath) === false) {
        log.info("missing directory `%s`", dirPath);
        try {
            log.info("making directory `%s`", dirPath);
            await mkdir(dirPath, { recursive: true });
        } catch (e) {
            log.fatal("failed to make directory `%s`", dirPath);
            console.error(e);
            process.exit(1);
        }
    }

    // copy if not exists
    if (existsSync(path) === false) {
        log.info("missing channels config `%s`", path);
        try {
            log.info("copying default channels config to `%s`", path);
            await copyFile("config/channels.yml", path);
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

// use queue because async fs ops is not thread safe
const configIOQueue = new Queue(1, Infinity);

async function load(name: "server", path: string): Promise<Server>;
async function load(name: "tuners", path: string): Promise<Tuner[]>;
async function load(name: "channels", path: string): Promise<Channel[]>;
async function load(name: "server" | "tuners" | "channels", path: string) {
    log.info("load %s config `%s`", name, path);

    return configIOQueue.add(async () => {
        return yaml.load(await readFile(path, "utf8"));
    });
}

async function save(name: "server", path: string, data: Server): Promise<void>;
async function save(name: "tuners", path: string, data: Tuner[]): Promise<void>;
async function save(name: "channels", path: string, data: Channel[]): Promise<void>;
async function save(name: "server" | "tuners" | "channels", path: string, data: object): Promise<void> {
    log.info("save %s config `%s`", name, path);

    await configIOQueue.add(async () => {
        await writeFile(path, yaml.dump(data));
    });
}

process.on("beforeExit", () => {
    if (configIOQueue.getQueueLength() + configIOQueue.getPendingLength() === 0) {
        return;
    }

    log.warn("configIOQueue is not empty. waiting for completion...");

    setTimeout(() => {
        log.warn("try to exit again...");
    }, 100);
});
