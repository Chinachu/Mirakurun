/*
   Copyright 2018 kanreisa

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
import * as api from "../api";
import Client from "./client";
import { IncomingMessage } from "http";

process.title = "Mirakurun: Remote";

process.stdin.resume();
process.stdin.on("data", () => exit());
process.on("SIGTERM", () => exit());

const opt = {
    host: process.argv[2],
    port: parseInt(process.argv[3], 10),
    type: process.argv[4] as api.ChannelType,
    channel: process.argv[5],
    decode: process.argv.includes("decode") === true && !process.argv.includes("rawTsmf=true"),
    rawTsmf: process.argv.includes("rawTsmf=true"),
    // 生のTSMFはTS、展開済みTLVはTLVを明示し、リモートの既定出力形式に依存しない。
    format: process.argv.slice(6).find(arg => arg === "ts" || arg === "tlv") as api.StreamFormat | undefined,
    // the relative stream of TSMF detected (the remote Mirakurun of 4.3.0 or before ignores it, and outputs the stream of the channel)
    tsmfRelTs: parseInt(process.argv.slice(6).find(arg => arg.startsWith("relTs="))?.slice(6) ?? "", 10) || undefined
};

console.error("remote:", opt);

/** the time to exit after started at least, if failed (not to request again and again at once) */
const RESPAWN_DELAY = 1000;
const startedAt = Date.now();

let stream: IncomingMessage;

const client = new Client();
client.host = opt.host;
client.port = opt.port;
client.userAgent = "Mirakurun (Remote)";

(async () => {
    // 親の照会後に接続先が変わると別のストリームが返り得るため、単独起動も含め子プロセス側で再確認する。
    // the remote Mirakurun of 4.3.0 or before outputs the stream of the channel (not the relative stream detected)
    if (opt.tsmfRelTs !== undefined && await client.supportsChannelStreamTsmfRelTs() === false) {
        console.error("remote:", "(error)", "tsmfRelTs is not supported");
        exit(3);
    }
    if (opt.rawTsmf && !await client.supportsChannelStreamRawTsmf()) {
        // 旧APIのformat=tsはNULLパケット保持を保証しないため、搬送波の原本転送には代用しない。
        console.error("remote:", "(error)", "raw TSMF is not supported");
        exit(2);
    }
    return client.getChannelStream({ type: opt.type, channel: opt.channel, decode: opt.decode,
        format: opt.rawTsmf ? "ts" : opt.format, tsmfRelTs: opt.tsmfRelTs, rawTsmf: opt.rawTsmf || undefined });
})()
    .then(_stream => {
        stream = _stream;
        stream.pipe(process.stdout);
        stream.once("end", () => exit());
    })
    .catch(err => {
        // JSON応答はstatus、ストリーム応答はstatusCodeにHTTPステータスを持つ。
        const status = err.statusCode ?? err.status;
        if (err.req) {
            console.error("remote:", "(error)", err.req.path, err.statusCode, err.statusMessage);
        } else if (status > 0) {
            console.error("remote:", "(error)", status, err.statusMessage ?? err.statusText);
        } else {
            const message = err instanceof Error ? err.message : err?.body instanceof Error ? err.body.message : err?.statusText || "ストリームの取得に失敗しました。";
            console.error("remote:", "(error)", message, err?.address ?? "", err?.code ?? "");
        }
        // 404/406だけを相対TSの拒否として保持する。401/403などの要求エラーは
        // 同じ要求の再起動を止めるが、相対TSの対応可否を確定しない（終了コード4）。
        // 未対応の能力は上の2/3、408/429や5xxは従来の再起動待機を使う。
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            exit(status === 404 || status === 406 ? 2 : 4);
        }
        setTimeout(() => exit(1), Math.max(0, startedAt + RESPAWN_DELAY - Date.now()));
    });

function exit(code = 0) {
    console.error("remote:", "exit.");

    if (stream) {
        stream.unpipe();
    }

    process.exit(code);
}
