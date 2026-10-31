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
import { promisify } from "util";
import { setImmediate as setImmediatePromise } from "timers/promises";
import * as yieldableJSON from "yieldable-json";
const stringifyAsync = promisify(yieldableJSON.stringifyAsync);
import * as express from "express";
import { stringifyJSONArray } from "./common";
import * as log from "./log";

export interface Error {
    readonly code: number;
    readonly reason: string;
    readonly errors: any[];
}

export function responseError(res: express.Response, code: number, reason?: string): express.Response {
    if (reason) {
        res.writeHead(code, reason, {
            "Content-Type": "application/json"
        });
    } else {
        res.writeHead(code, {
            "Content-Type": "application/json"
        });
    }

    const error: Error = {
        code: code,
        reason: reason || null,
        errors: []
    };

    res.end(JSON.stringify(error));

    return res;
}

export function responseStreamErrorHandler(res: express.Response, err: NodeJS.ErrnoException): express.Response {
    if (err.message === "no available tuners") {
        return responseError(res, 503, "Tuner Resource Unavailable");
    }

    return responseError(res, 500, err.message);
}

/**
 * 配列は数回に分けて書き出すため、書き出しの途中で中身が変わる配列 (内部で保持している配列など) は、複製して渡すこと。
 */
export async function responseJSON(res: express.Response, body: any): Promise<express.Response> {
    // this is lighter than res.json()
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200);

    // HEAD は本文を送らないため、文字列化しない
    if (res.req?.method === "HEAD") {
        res.end();
        return res;
    }

    try {
        if (Array.isArray(body)) {
            await writeJSONArray(res, body);
        } else {
            res.end(await stringifyAsync(body));
        }
    } catch (e) {
        log.error("JSON response of `%s %s` has failed (%s: %s)", res.req?.method, res.req?.originalUrl, e.name, e.message);
        // 書き出し前なら 500 を返し、途中なら接続を閉じて応答が途切れたことをクライアントに伝える (切断済みなら何もしない)
        if (!res.destroyed) {
            if (res.headersSent) {
                res.destroy();
            } else {
                responseError(res, 500);
            }
        }
    }

    return res;
}

/**
 * 配列は全体を 1 つの文字列にせず、少しずつ書き出す (番組一覧などの大きな応答でメモリを使い込まないため)
 *
 * db.ts のように stream の pipeline へ渡さないのは、次の 2 点を保つため。
 * - 1 回で書き出せる大きさの応答は、従来どおり Content-Length を付ける。
 * - 送信が詰まらない速い接続でも、書き出しのたびに配信などの他の処理へ順番を譲る
 *   (pipeline では続けて書き出すため、番組一覧で他の処理が 10ms 以上待たされた)。
 */
async function writeJSONArray(res: express.Response, items: any[]): Promise<void> {
    const chunks = stringifyJSONArray(items);
    let chunk: string = chunks.next().value;

    while (!res.destroyed) {
        const next = chunks.next();
        if (next.done) {
            // 1 回で書き出せる大きさなら、従来どおり Content-Length 付きの応答になる
            res.end(chunk);
            return;
        }

        if (res.write(chunk)) {
            // 送信が詰まらない場合も、配信などの他の処理を止め続けないよう順番を譲る
            await setImmediatePromise();
        } else {
            await waitForDrain(res);
        }
        chunk = next.value;
    }
}

function waitForDrain(res: express.Response): Promise<void> {
    return new Promise(resolve => {
        // 既に閉じていれば drain も close も発生しない
        if (res.destroyed) {
            resolve();
            return;
        }
        const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
        };
        res.on("drain", done);
        res.on("close", done);
    });
}
