/*
   Copyright 2026 Till0196

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
import * as apid from "../../api";

const TS_PACKET_SIZE = 188;
/** TS packets in a row to detect TS */
const TS_PACKETS = 10;
/** TLV packets in a row to detect TLV */
const TLV_PACKETS = 5;
/** IPv4, IPv6, compressed IP, signalling, null (ARIB STD-B32) */
const TLV_TYPES = new Set([0x01, 0x02, 0x03, 0xFE, 0xFF]);

/**
 * the bytes skipped at the start of the stream to detect the format,
 * since the data of the channel tuned before may remain right after tuning
 */
export const DETECT_SKIP_BYTES = 64 * 1024;
/** the bytes to detect the format after skipping */
export const DETECT_BYTES = 64 * 1024;

/**
 * detects the format of the data received (by the service scan only, the streams do not detect)
 * @returns `null` if unknown
 */
export function detectStreamFormat(data: Buffer): apid.StreamFormat | null {
    // the format continued longer, a part of the data may look like the other format by chance
    const ts = coverTS(data);
    const tlv = coverTLV(data);
    if (Math.max(ts, tlv) < data.length / 2) {
        return null;
    }
    return ts >= tlv ? "ts" : "tlv";
}

/**
 * detects the format of the relative stream of TSMF by stream_type of the TSMF headers
 * (decided by 2 headers in a row of continuity_counter, the frame of the channel tuned before may remain)
 * @returns `null` if unknown
 */
export function detectTSMFStreamFormat(data: Buffer, relTs: number): apid.StreamFormat | null {
    // keep the module of TSMF out of the path only for TS
    const { parseTSMFHeader } = require("./TSMFTLV") as typeof import("./TSMFTLV");
    let last: { cc: number, isTlv: boolean } = null;
    for (let i = 0; i + TS_PACKET_SIZE <= data.length; i++) {
        if (data[i] !== 0x47 || (((data[i + 1] & 0x1F) << 8) | data[i + 2]) !== 0x2F) {
            continue;
        }
        const packet = data.subarray(i, i + TS_PACKET_SIZE);
        const header = parseTSMFHeader(packet);
        if (header === null) {
            last = null;
            continue;
        }
        const cc = packet[3] & 0x0F;
        const isTlv = ((header.streamTypeBits >> (15 - relTs)) & 1) === 0;
        if (last !== null && cc === ((last.cc + 1) & 0x0F) && isTlv === last.isTlv) {
            return isTlv ? "tlv" : "ts";
        }
        last = { cc, isTlv };
        i += TS_PACKET_SIZE - 1;
    }
    return null;
}

/** the bytes of the TS packets in a row from the first sync */
function coverTS(data: Buffer): number {
    let best = 0;
    for (let i = 0; i < TS_PACKET_SIZE && i < data.length; i++) {
        let n = 0;
        while (i + TS_PACKET_SIZE * n < data.length && data[i + TS_PACKET_SIZE * n] === 0x47) {
            n++;
        }
        if (n >= TS_PACKETS) {
            best = Math.max(best, TS_PACKET_SIZE * n);
        }
    }
    return best;
}

/** the bytes of the TLV packets in a row */
function coverTLV(data: Buffer): number {
    let best = 0;
    for (let i = data.indexOf(0x7F); i !== -1 && i + 4 <= data.length && best < data.length / 2; i = data.indexOf(0x7F, i + 1)) {
        let pos = i;
        let n = 0;
        while (pos + 4 <= data.length && data[pos] === 0x7F && TLV_TYPES.has(data[pos + 1])) {
            const next = pos + 4 + data.readUInt16BE(pos + 2);
            if (next > data.length) {
                break;
            }
            pos = next;
            n++;
        }
        if (n >= TLV_PACKETS) {
            best = Math.max(best, pos - i);
        }
    }
    return best;
}
