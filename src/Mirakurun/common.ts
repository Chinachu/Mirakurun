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
import rfdc from "rfdc";
import ChannelItem from "./ChannelItem";
import * as apid from "../../api";

export { parseCommandForSpawn } from "./command";

export interface User {
    readonly id: string;
    readonly priority: number;
    readonly agent?: string;
    readonly url?: string;
    readonly disableDecoder?: boolean;
    readonly streamSetting?: StreamSetting;
    readonly streamInfo?: StreamInfo;
}

export type UserRequest = Omit<User, "streamSetting">;

interface StreamSetting {
    channel: ChannelItem;
    networkId?: number;
    serviceId?: number;
    eventId?: number;
    parseNIT?: boolean;
    parseSDT?: boolean;
    parseEIT?: boolean;
}

export interface StreamInfo {
    [PID: string]: {
        packet: number;
        drop: number;
    };
}

export const channelTypes: apid.ChannelType[] = ["GR", "BS", "CS", "SKY"];

export class WhereQueryError extends Error {
    readonly code = "WHERE_QUERY";
    readonly status = 400;

    constructor() {
        super("$where is not allowed");
        this.name = "WhereQueryError";
    }
}

export function rejectWhere(query: unknown, seen?: WeakSet<object>): void {
    if (query === null || typeof query !== "object") {
        return;
    }

    const visited = seen || new WeakSet<object>();
    if (visited.has(query)) {
        return;
    }
    visited.add(query);

    for (const key in query) {
        if (key === "$where") {
            throw new WhereQueryError();
        }
        rejectWhere((query as { [key: string]: unknown })[key], visited);
    }
}

export const deepClone = rfdc();

export function updateObject<T, U>(target: T, input: U): boolean;
export function updateObject<T extends any[], U extends any[]>(target: T, input: U): boolean {
    let updated = false;

    for (const k in input) {
        if (Array.isArray(target[k]) && Array.isArray(input[k])) {
            updated = updateArray(target[k], input[k]) || updated;
            continue;
        } else if (target[k] === null && input[k] === null) {
            continue;
        } else if (typeof target[k] === "object" && typeof input[k] === "object") {
            updated = updateObject(target[k], input[k]) || updated;
            continue;
        } else if (target[k] === input[k]) {
            continue;
        }

        target[k] = input[k];
        updated = true;
    }

    return updated;
}

function updateArray<T extends any[], U extends any[]>(target: T, input: U): boolean {
    const length = target.length;

    if (length !== input.length) {
        target.splice(0, length, ...input);
        return true;
    }

    let updated = false;

    for (let i = 0; i < length; i++) {
        if (Array.isArray(target[i]) && Array.isArray(input[i])) {
            updated = updateArray(target[i], input[i]) || updated;
            continue;
        } else if (target[i] === null && input[i] === null) {
            continue;
        } else if (typeof target[i] === "object" && typeof input[i] === "object") {
            updated = updateObject(target[i], input[i]) || updated;
            continue;
        } else if (target[i] === input[i]) {
            continue;
        }

        target[i] = input[i];
        updated = true;
    }

    return updated;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

const JSON_ARRAY_CHUNK_LENGTH = 32 * 1024;

/** 配列を連結した JSON 配列を、全体を 1 つの文字列にせず一定の長さごとに文字列化する */
export function* stringifyJSONArray(...arrays: readonly unknown[][]): Generator<string> {
    let chunk = "[";
    let first = true;
    for (const array of arrays) {
        for (const item of array) {
            const json = JSON.stringify(item);
            // JSON にできない要素 (undefined や関数) は、従来 (yieldable-json) と同じく出力しない
            // (要素の中にある配列では、JSON.stringify と同じく null になる)
            if (json === undefined) {
                continue;
            }
            chunk += (first ? "" : ",") + json;
            first = false;
            if (chunk.length >= JSON_ARRAY_CHUNK_LENGTH) {
                yield chunk;
                chunk = "";
            }
        }
    }
    yield chunk + "]";
}

export function getTimeFromMJD(buffer: Uint8Array | Buffer): number {
    const mjd = (buffer[0] << 8) | buffer[1];
    const h = (buffer[2] >> 4) * 10 + (buffer[2] & 0x0F);
    const i = (buffer[3] >> 4) * 10 + (buffer[3] & 0x0F);
    const s = (buffer[4] >> 4) * 10 + (buffer[4] & 0x0F);

    return ((mjd - 40587) * 86400 + ((h - 9) * 60 * 60) + (i * 60) + s) * 1000;
}

export function getTimeFromBCD24(buffer: Uint8Array | Buffer): number {
    let time = ((buffer[0] >> 4) * 10 + (buffer[0] & 0x0F)) * 3600;
    time += ((buffer[1] >> 4) * 10 + (buffer[1] & 0x0F)) * 60;
    time += (buffer[2] >> 4) * 10 + (buffer[2] & 0x0F);

    return time * 1000;
}

export function replaceCommandTemplate(template: string, vars: Record<string, string | number>): string {
    return template.replace(/<([a-z0-9\-_\.]+)>/gi, (match, key) => {
        return vars[key] !== undefined ? String(vars[key]) : "";
    });
}
