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
import { createWriteStream, existsSync, readFileSync } from "fs";
import { copyFile, mkdir, readFile, rename, rm } from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import * as yieldableJSON from "yieldable-json";
const parseAsync = promisify(yieldableJSON.parseAsync);
import Queue from "promise-queue";
import * as apid from "../../api";
import * as log from "./log";
import { stringifyJSONArray, getDefaultChannelRoute } from "./common";

export interface Service extends apid.Service {
    /** 公開DTOには含めない保存時の受信設定。 */
    reception?: Channel["reception"];
    /** @deprecated */
    logoData?: string; // base64
}

/** the streams received last time on the channel. */
export interface Channel {
    type: apid.ChannelType;
    channel: string;
    streams: ChannelStream[];
    /** 保存時の受信設定。旧形式では欠落しているためintegrityの一致が必要です。 */
    reception?: {
        route: apid.ChannelRoute;
        tsmfRelTs?: number;
        format?: apid.StreamFormat;
        tsmfGroupId?: number;
        commandVars?: Record<string, string | number>;
    };
}

export interface ChannelStream {
    networkId: number;
    streamId: number;
    format?: apid.StreamFormat;
    /** TSMF */
    relTs?: number;
    /** TSMF */
    slots?: number;
    groupId?: number;
    numberOfCarriers?: number;
    carrierSequence?: number;
    tsmfNetworkId?: number;
    tsmfStreamId?: number;
    /** TSMF: detected by the remote Mirakurun */
    remote?: boolean;
}

export interface Program extends apid.Program {
    /** (internal) indicates EIT[p/f] received */
    _pf?: true; // for compatibility
    _isPresent?: true;
    _isFollowing?: true;
}

export async function loadServices(integrity: string, sync = false): Promise<Service[]> {
    return load(process.env.SERVICES_DB_PATH, integrity, sync, "services");
}

export async function saveServices(data: Service[], integrity: string): Promise<void> {
    return save(process.env.SERVICES_DB_PATH, data, integrity);
}

export async function loadChannels(integrity: string, sync = false): Promise<Channel[]> {
    return load(process.env.CHANNELS_DB_PATH, integrity, sync, "channels");
}

export async function saveChannels(data: Channel[], integrity: string): Promise<void> {
    return save(process.env.CHANNELS_DB_PATH, data, integrity);
}

/** 検出値ではなく、選局・分離・結合に使う設定だけを保存する。 */
export function channelStateReception(config: apid.ConfigChannelsItem): NonNullable<Channel["reception"]> {
    const rawRelTs: unknown = config.tsmfRelTs;
    const relTs = rawRelTs === 0 || rawRelTs === null || rawRelTs === "" ? undefined : config.tsmfRelTs;
    return {
        route: config.route || getDefaultChannelRoute(config.type),
        ...(relTs !== undefined && { tsmfRelTs: relTs }),
        ...(config.format !== undefined && { format: config.format }),
        ...(config.tsmfGroupId !== undefined && { tsmfGroupId: config.tsmfGroupId }),
        commandVars: { ...config.commandVars }
    };
}

/** 名前・serviceId・isDisabledは受信入力を変えない。変数は順序によらず型も含めて照合する。 */
export function channelStateMatches(record: Pick<Channel, "type" | "channel" | "reception">, config: apid.ConfigChannelsItem): boolean {
    if (record.type !== config.type || record.channel !== config.channel) { return false; }
    // 旧形式はloadChannelsでintegrityを確認済みのものだけが届く。
    if (record.reception === undefined) { return true; }
    const saved = record.reception;
    if (!saved || typeof saved !== "object") { return false; }
    const current = channelStateReception(config);
    const savedVars = saved.commandVars || {};
    const currentVars = current.commandVars || {};
    return saved.route === current.route && saved.tsmfRelTs === current.tsmfRelTs && saved.format === current.format &&
        saved.tsmfGroupId === current.tsmfGroupId && Object.keys(savedVars).length === Object.keys(currentVars).length &&
        Object.keys(savedVars).every(key => savedVars[key] === currentVars[key]);
}

export async function loadPrograms(integrity: string, sync = false): Promise<Program[]> {
    return load(process.env.PROGRAMS_DB_PATH, integrity, sync);
}

export async function savePrograms(data: Program[], integrity: string): Promise<void> {
    return save(process.env.PROGRAMS_DB_PATH, data, integrity);
}

// use queue because async fs ops is not thread safe
const dbIOQueue = new Queue(1, Infinity);

async function load(path: string, integrity: string, sync = false, receptionState?: "channels" | "services"): Promise<any[]> {
    log.info("load db `%s` w/ integrity (%s)", path, integrity);

    return dbIOQueue.add(async () => {
        if (existsSync(path) === false) {
            log.info("db `%s` is not exists", path);
            return [];
        }

        const json = sync ? readFileSync(path, "utf8") : await readFile(path, "utf8");
        try {
            const array: any[] = sync ? JSON.parse(json) : await parseAsync(json);
            if (array.length > 0 && array[0].__integrity__) {
                if (integrity === array[0].__integrity__) {
                    return array.slice(1);
                } else {
                    // 新形式はChannel/Serviceのloadで受信設定を照合し、名前・有効/無効だけの変更では捨てない。
                    const channels = receptionState ? array.slice(1).filter(item => item?.reception !== undefined) : [];
                    if (!receptionState || channels.length !== array.length - 1) { log.warn("db `%s` integrity check has failed", path); }
                    return channels;
                }
            }
            if (receptionState === "channels") {
                // ヘッダーのない旧形式は受信入力との一致を証明できない。新形式だけChannel.loadで行ごとに照合する。
                const channels = array.filter(item => item?.reception !== undefined);
                if (channels.length !== array.length) { log.warn("⚠️ DB `%s` に整合性情報がないため、受信設定を照合できない経路を再スキャンします。", path); }
                return channels;
            }
            return array;
        } catch (e) {
            log.error("db `%s` is broken (%s: %s)", path, e.name, e.message);
            return [];
        }
    });
}

async function save(path: string, data: any[], integrity: string): Promise<void> {
    log.info("save db `%s` w/ integrity (%s)", path, integrity);

    return dbIOQueue.add(async () => {
        // JSON 全体を 1 つの文字列にせず、一時ファイルへ少しずつ書き出してから置き換える
        // (書き込み途中の停止やエラーで既存のファイルを壊さないため)
        const tmpPath = `${path}.tmp`;
        try {
            await mkdir(dirname(path), { recursive: true });
            await pipeline(
                Readable.from(stringifyJSONArray([{ __integrity__: integrity }], data)),
                createWriteStream(tmpPath)
            );
            try {
                await rename(tmpPath, path);
            } catch (e) {
                // ファイル単体がバインドマウントされている場合などは置き換えられないため、内容をコピーする
                if (e.code !== "EBUSY" && e.code !== "EXDEV") {
                    throw e;
                }
                await copyFile(tmpPath, path);
            }
        } catch (e) {
            log.error("db `%s` save has failed (%s: %s)", path, e.name, e.message);
        } finally {
            await rm(tmpPath, { force: true });
        }
    });
}

process.on("beforeExit", () => {
    if (dbIOQueue.getQueueLength() + dbIOQueue.getPendingLength() === 0) {
        return;
    }

    log.warn("dbIOQueue is not empty. waiting for completion...");

    setTimeout(() => {
        log.warn("try to exit again...");
    }, 100);
});
