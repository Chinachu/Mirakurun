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
import * as apid from "../../api";
import { StreamFilter, UserRequest, stringifyJSONArray } from "./common";
import * as log from "./log";
import _ from "./_";
import type ChannelItem from "./ChannelItem";
import type { StreamTarget } from "./Tuner";

/** この搬送波で受信できるサービスと、取得に必要な相対TSの検出情報を返す。 */
export function getChannelServices(channel: ChannelItem): apid.Service[] {
    const streams = channel.streams;
    // 設定で相対TSを固定していないチャンネルだけ、検出済みの相対TS情報を付ける。
    const hasRelativeStreams = channel.tsmfRelTs === undefined && streams.some(stream => stream.relTs !== undefined);
    return channel.getServices().map(service => {
        const result: apid.Service = {
            id: service.id,
            serviceId: service.serviceId,
            networkId: service.networkId,
            streamId: service.streamId,
            name: service.name,
            type: service.type
        };
        if (hasRelativeStreams) {
            const relative = streams.find(stream => stream.networkId === service.networkId && stream.streamId === service.streamId);
            if (relative?.relTs !== undefined) {
                result.tsmfRelTs = relative.relTs;
                // リモートで相対TSを取得するための検出形式を返す。チャンネル設定のformatは反映しない。
                if (relative.format) {
                    result.format = relative.format;
                }
            }
        }
        return result;
    });
}

export interface Error {
    readonly code: number;
    readonly reason: string;
    readonly errors: any[];
}

export function responseError(res: express.Response, code: number, reason?: string): express.Response {
    // 日本語の理由はJSON本文に保持し、HTTPのstatusMessageへは渡さない。
    if (reason && /^[\x20-\x7E]+$/.test(reason)) {
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
    if (err.code === "ERR_STREAM_FORMAT_UNAVAILABLE") {
        return responseError(res, 406, "Requested Stream Format Unavailable");
    }
    if (err.code === "ERR_DECODER_START_FAILED") {
        return responseError(res, 503, "Decoder Unavailable");
    }
    if (err.message === "no available tuners" || err.code === "ERR_TUNER_UNAVAILABLE") {
        return responseError(res, 503, "Tuner Resource Unavailable");
    }

    return responseError(res, 500, err.message);
}

/** the query parameter of the stream APIs */
export const streamFormatParameter = {
    in: "query",
    name: "format",
    type: "string",
    enum: ["ts", "tlv"],
    description: "配信するストリーム形式です。formatを省略すると、TS入力はts、TLV（MMT）入力はサーバー設定のdefaultTlvStreamFormat（未設定時はtlv）で配信します。formatを明示するとサーバーの既定値より優先します。tlvを指定できるのはTLV入力だけです。TLVをtsで取得するにはtlvToTsDecoderの設定が必要です。チャンネル配信のrawTsmf=trueでは、省略時もtsで配信します。"
};

/**
 * responds a stream (GET and HEAD use the same output format)
 * @param targets the channels (and the relative streams of TSMF) to receive the stream
 * @param start starts the stream with the user request
 */
export function responseStream(
    req: express.Request,
    res: express.Response,
    targets: StreamTarget[],
    start: (userReq: UserRequest) => Promise<StreamFilter>
): Promise<StreamFilter | null> {
    const outputFormat = _.tuner.getOutputFormat(targets, req.query.format as apid.StreamFormat);
    if (outputFormat === null) {
        responseError(res, 406, "Requested Stream Format Unavailable");
        return Promise.resolve(null);
    }

    const userId = (req.ip || "unix") + ":" + (req.socket.remotePort || Date.now());
    const contentType = outputFormat === "tlv" ? "application/octet-stream" : "video/MP2T";

    // HEAD request support
    if (req.method === "HEAD") {
        res.setHeader("Content-Type", contentType);
        res.setHeader("X-Mirakurun-Tuner-User-ID", userId);
        res.status(200).end();
        return Promise.resolve(null);
    }

    let requestAborted = false;
    req.once("close", () => requestAborted = true);

    (<any> res.socket)._writableState.highWaterMark = Math.max(res.writableHighWaterMark, 1024 * 1024 * 16);
    res.socket.setNoDelay(true);

    return start({
        id: userId,
        priority: parseInt(req.get("X-Mirakurun-Priority"), 10) || 0,
        agent: req.get("User-Agent"),
        url: req.url,
        disableDecoder: (<number> <any> req.query.decode === 0),
        outputFormat
    })
        .then(tsFilter => {
            if (requestAborted === true || req.aborted === true) {
                tsFilter.close();
                return null;
            }

            req.once("close", () => tsFilter.close());

            res.setHeader("Content-Type", contentType);
            res.setHeader("X-Mirakurun-Tuner-User-ID", userId);
            res.status(200);

            return tsFilter;
        })
        .catch(err => {
            responseStreamErrorHandler(res, err);
            return null;
        });
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
    // Keep small listings in one bounded write as their metadata grows.
    let coalesce = items.length <= 512;
    // まとめる上限はUTF-8の送信量で数え、要素単体のJSONは途中で分割しない。
    let chunkBytes = coalesce ? Buffer.byteLength(chunk) : 0;

    while (!res.destroyed) {
        const next = chunks.next();
        if (next.done) {
            // 1 回で書き出せる大きさなら、従来どおり Content-Length 付きの応答になる
            res.end(chunk);
            return;
        }

        const nextBytes = coalesce ? Buffer.byteLength(next.value) : 0;
        if (coalesce && chunkBytes + nextBytes <= 128 * 1024) {
            chunk += next.value;
            chunkBytes += nextBytes;
            continue;
        }
        coalesce = false;

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
