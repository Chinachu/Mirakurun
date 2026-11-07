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
import * as apid from "../api";
import Client from "./client";
import { IncomingMessage } from "http";

process.title = "Mirakurun: Remote";

process.stdin.resume();
process.stdin.on("data", () => exit());
process.on("SIGTERM", () => exit());

const opt = {
    host: process.argv[2],
    port: parseInt(process.argv[3], 10),
    type: process.argv[4] as apid.ChannelType,
    channel: process.argv[5],
    decode: process.argv.includes("decode") === true,
    // the local TLVFilter needs TLV regardless of `defaultTlvStreamFormat` of the remote
    format: process.argv.slice(6).includes("tlv") ? "tlv" as apid.StreamFormat : undefined,
    // the relative stream of TSMF detected (the remote Mirakurun of 4.3.0 or before ignores it, and outputs the stream of the channel)
    tsmfRelTs: parseInt(process.argv.slice(6).find(arg => arg.startsWith("relTs="))?.slice(6), 10) || undefined
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
    // the remote Mirakurun of 4.3.0 or before outputs the stream of the channel (not the relative stream detected)
    if (opt.tsmfRelTs !== undefined && await client.supportsChannelStreamTsmfRelTs() === false) {
        console.error("remote:", "(error)", "tsmfRelTs is not supported");
        exit(3);
    }
    return client.getChannelStream({ type: opt.type, channel: opt.channel, decode: opt.decode, format: opt.format, tsmfRelTs: opt.tsmfRelTs });
})()
    .then(_stream => {
        stream = _stream;
        stream.pipe(process.stdout);
        stream.once("end", () => exit());
    })
    .catch(err => {
        if (err.req) {
            console.error("remote:", "(error)", err.req.path, err.statusCode, err.statusMessage);
        } else if (err.statusCode) {
            console.error("remote:", "(error)", err.statusCode, err.statusMessage);
        } else {
            console.error("remote:", "(error)", err.address, err.code);
        }
        // the remote Mirakurun has refused the request (the same request is refused again),
        // respawned if not available for now (such as 503 for the tuners in use, as before, after a while if failed at once)
        if ([400, 404, 406].includes(err.statusCode)) {
            exit(2);
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
