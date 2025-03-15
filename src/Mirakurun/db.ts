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
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { promisify } from "util";
import * as yieldableJSON from "yieldable-json";
const parseAsync = promisify(yieldableJSON.parseAsync);
const stringifyAsync = promisify(yieldableJSON.stringifyAsync);
import Queue from "promise-queue";
import * as apid from "../../api";
import * as log from "./log";

interface Service extends apid.Service {
    /** @deprecated */
    logoData?: string; // base64
}

type Channel = apid.Channel;

export interface Program extends apid.Program {
    /** (internal) indicates EIT[p/f] received */
    _pf?: true; // for compatibility
    _isPresent?: true;
    _isFollowing?: true;
}

export async function loadServices(integrity: string): Promise<Service[]> {
    return load(process.env.SERVICES_DB_PATH, integrity);
}

export async function saveServices(data: Service[], integrity: string): Promise<void> {
    return save(process.env.SERVICES_DB_PATH, data, integrity);
}

export async function loadPrograms(integrity: string): Promise<Program[]> {
    return load(process.env.PROGRAMS_DB_PATH, integrity);
}

export async function savePrograms(data: Program[], integrity: string): Promise<void> {
    return save(process.env.PROGRAMS_DB_PATH, data, integrity);
}

// use queue because async fs ops is not thread safe
const dbIOQueue = new Queue(1, Infinity);

async function load(path: string, integrity: string): Promise<any[]> {
    log.info("load db `%s` w/ integrity (%s)", path, integrity);

    return dbIOQueue.add(async () => {
        if (existsSync(path) === true) {
            const json = await readFile(path, "utf8");
            try {
                const array: any[] = await parseAsync(json);
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
        }

        log.info("db `%s` is not exists", path);
        return [];
    });
}

async function save(path: string, data: any[], integrity: string, retrying = false): Promise<void> {
    log.info("save db `%s` w/ integrity (%s)", path, integrity);

    if (retrying === false) {
        data.unshift({ __integrity__: integrity });
    }

    return dbIOQueue.add(async () => {
        try {
            await writeFile(path, await stringifyAsync(data));
        } catch (e) {
            if (retrying === false) {
                // mkdir if not exists
                const dirPath = dirname(path);
                if (existsSync(dirPath) === false) {
                    try {
                        await mkdir(dirPath, { recursive: true });
                    } catch (e) {
                        throw e;
                    }
                }
                // retry
                await save(path, data, integrity, true);
            }
            throw e;
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
