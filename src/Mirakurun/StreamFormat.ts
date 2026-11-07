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

/** a relative stream of TSMF */
export interface TSMFStream {
    relTs: number;
    /** the slots in a frame */
    slots: number;
    format: apid.StreamFormat;
    /** stream_id of the TSMF header (transport_stream_id or tlv_stream_id) */
    streamId: number;
    networkId: number;
    groupId?: number;
    numberOfCarriers?: number;
    carrierSequence?: number;
}

/**
 * the relative streams of TSMF by the TSMF headers
 * (decided by 2 headers in a row of continuity_counter with the same contents, the frame of the channel tuned before may remain)
 * @param multiCarrier `false` to treat the frames of multiple carriers as not TSMF (they cannot be received)
 * @returns `null` if not TSMF, `[]` if TSMF but not decided (packets lost)
 */
export function detectTSMFStreams(data: Buffer, multiCarrier = true): TSMFStream[] | null {
    let parseTSMFHeader: typeof import("./TSMFTLV").parseTSMFHeader = null;
    let last: { cc: number, key: string, pos: number, slotMap: number[] } = null;
    let found = false;
    /** decided by the headers, the frame between them has lost packets to verify TLV */
    let decided: TSMFStream[] = null;
    for (let i = 0; i + TS_PACKET_SIZE <= data.length; i++) {
        if (data[i] !== 0x47 || (((data[i + 1] & 0x1F) << 8) | data[i + 2]) !== 0x2F) {
            continue;
        }
        // keep the module of TSMF out of the path without TSMF
        parseTSMFHeader ??= (require("./TSMFTLV") as typeof import("./TSMFTLV")).parseTSMFHeader;
        const packet = data.subarray(i, i + TS_PACKET_SIZE);
        // frame_sync: the headers broken (CRC) by the reception are TSMF but not decided
        const frameSync = ((packet[4] << 8) | packet[5]) & 0x1FFF;
        if (frameSync === 0x1A86 || frameSync === 0x0579) {
            found = true;
        }
        const header = parseTSMFHeader(packet);
        if (header === null) {
            last = null;
            continue;
        }
        const pos = i;
        i += TS_PACKET_SIZE - 1;

        const payload = packet.subarray(4);
        const streams: TSMFStream[] = [];
        for (let relTs = 1; relTs <= 15; relTs++) {
            const slots = header.slotMap.filter(n => n === relTs).length;
            if (slots === 0) {
                continue;
            }
            const offset = 5 + (relTs - 1) * 4;
            streams.push({
                relTs,
                slots,
                format: ((header.streamTypeBits >> (15 - relTs)) & 1) === 0 ? "tlv" : "ts",
                streamId: payload.readUInt16BE(offset),
                networkId: payload.readUInt16BE(offset + 2),
                ...(header.numberOfCarriers > 1 && { groupId: header.groupId, numberOfCarriers: header.numberOfCarriers, carrierSequence: header.carrierSequence })
            });
        }

        const cc = packet[3] & 0x0F;
        const key = JSON.stringify([header.numberOfCarriers, streams]);
        if (last !== null && cc === ((last.cc + 1) & 0x0F) && key === last.key) {
            if (multiCarrier === false && header.numberOfCarriers > 1) {
                return null;
            }
            // the frame between the headers (header + 52 slots) without the packets lost, of the slots of the header before it
            if (pos - last.pos === (last.slotMap.length + 1) * TS_PACKET_SIZE) {
                verifyTLV(data, last.pos, last.slotMap, streams);
                return streams;
            }
            if (streams.some(stream => stream.format === "tlv") === false) {
                return streams;
            }
            // TLV is verified by a later frame without the packets lost
            decided ??= streams;
        }
        last = { cc, key, pos, slotMap: header.slotMap };
    }
    return decided ?? (found ? [] : null);
}

/**
 * TLV of TSMF is carried on PID 0x2D, the relative stream of stream_type TLV is TS if its packets in the frame are of the other PIDs
 * (stream_type is reserved in TSMF before extended)
 */
function verifyTLV(data: Buffer, headerPos: number, slotMap: number[], streams: TSMFStream[]): void {
    for (const stream of streams) {
        if (stream.format !== "tlv") {
            continue;
        }
        let tlv = 0;
        let other = 0;
        for (let slot = 0; slot < slotMap.length; slot++) {
            if (slotMap[slot] !== stream.relTs) {
                continue;
            }
            const p = headerPos + TS_PACKET_SIZE * (slot + 1);
            const pid = ((data[p + 1] & 0x1F) << 8) | data[p + 2];
            if (data[p] !== 0x47 || pid === 0x1FFF) {
                continue;
            }
            if (pid === 0x2D) {
                tlv++;
            } else {
                other++;
            }
        }
        if (tlv === 0 && other > 0) {
            stream.format = "ts";
        }
    }
}

/**
 * detects the format of the relative stream of TSMF by stream_type of the TSMF headers
 * @returns `null` if unknown
 */
export function detectTSMFStreamFormat(data: Buffer, relTs: number): apid.StreamFormat | null {
    return detectTSMFStreams(data)?.find(stream => stream.relTs === relTs)?.format || null;
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
