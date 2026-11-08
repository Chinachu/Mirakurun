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
import { TsCrc32 } from "@chinachu/aribts";
import * as log from "./log";

export const PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;
export const TSMF_PID = 0x2F;
export const TLV_PID = 0x2D;
const NULL_PID = 0x1FFF;
export const SLOT_COUNT = 52;
const TSMF_FRAME_SYNC = [0x1A86, 0x0579];

const TLV_SYNC_BYTE = 0x7F;
const TLV_HEADER_SIZE = 4;

/** the header of a TSMF frame (ARIB STD-B32 / JCTEA STD-002) */
export interface TSMFHeader {
    /** 0x1: multi-TS (the extended TSMF may have a part of the bonded carriers), 0x2: the bonded carriers only */
    frameType: number;
    /** relative stream number of each slot (0 = unused) */
    slotMap: number[];
    /** bit of relative stream n (MSB = 1): 0 = TLV, 1 = TS */
    streamTypeBits: number;
    /** 1 unless the carriers are bonded (frame_type 0x2 may also have 1), see `isBondedStream()` */
    numberOfCarriers: number;
    groupId: number;
    /** the order of the carrier (0 or 1..numberOfCarriers, the start is not specified), 1 for a single carrier */
    carrierSequence: number;
    /** the frames of a super frame */
    numberOfFrames: number;
    framePosition: number;
}

export function parseTSMFHeader(packet: Buffer): TSMFHeader | null {
    if ((packet[1] & 0x80) !== 0) {
        return null;
    }
    const payload = packet.subarray(4, PACKET_SIZE);

    if (TSMF_FRAME_SYNC.includes(((payload[0] << 8) | payload[1]) & 0x1FFF) === false) {
        return null;
    }
    if (TsCrc32.calc(payload) !== 0) {
        return null;
    }

    const slotMap: number[] = new Array(SLOT_COUNT);
    for (let i = 0; i < SLOT_COUNT; i++) {
        const b = payload[69 + (i >> 1)];
        slotMap[i] = (i & 1) === 0 ? b >> 4 : b & 0x0F;
    }

    const frameType = payload[2] & 0x0F;
    // frame_type 0x1 of the extended TSMF may have a part of the bonded carriers with the streams of multi-TS,
    // the extension is all '1' in TSMF not extended (number_of_carriers is 2-255, group_id is not 0)
    // (high-level cable broadcasting interim report 4.3.3.4, 4.3.4, carrier_sequence may start from 0 as frame_type 0x2)
    const isMultiCarrier = frameType === 0x02 || (frameType === 0x01 && payload[123] !== 0x00 &&
        payload[124] >= 2 && payload[124] !== 0xFF && payload[125] <= payload[124]);
    // frame_type 0x2 (multi-carrier) of a single carrier is the same as the others
    const numberOfCarriers = isMultiCarrier ? Math.max(payload[124], 1) : 1;
    const carrierSequence = numberOfCarriers > 1 ? payload[125] : 1;
    if (carrierSequence > numberOfCarriers) {
        return null;
    }

    return {
        frameType,
        slotMap,
        streamTypeBits: (payload[121] << 7) | (payload[122] >> 1),
        numberOfCarriers,
        groupId: isMultiCarrier ? payload[123] : 0,
        carrierSequence,
        numberOfFrames: isMultiCarrier ? Math.max(payload[126] >> 4, 1) : 1,
        framePosition: isMultiCarrier ? payload[126] & 0x0F : 0
    };
}

export function isTLVStream(header: TSMFHeader, relTs: number): boolean {
    return ((header.streamTypeBits >> (15 - relTs)) & 1) === 0;
}

/**
 * whether the relative stream is carried by the bonded carriers
 * (frame_type 0x1 has the streams of multi-TS with a part of the bonded carriers, the stream of TLV is taken as the part)
 */
export function isBondedStream(header: TSMFHeader, relTs: number): boolean {
    return header.numberOfCarriers > 1 && (header.frameType !== 0x01 || isTLVStream(header, relTs));
}

/** splits the chunks into the TS packets */
export class TSPacketReader {
    private _packet = Buffer.allocUnsafe(PACKET_SIZE);
    private _packetLength = 0;

    constructor(private _onPacket: (packet: Buffer) => void, private _onLost: () => void) {
    }

    push(chunk: Buffer): void {
        let offset = 0;

        if (this._packetLength > 0) {
            const need = PACKET_SIZE - this._packetLength;
            if (chunk.length < need) {
                chunk.copy(this._packet, this._packetLength);
                this._packetLength += chunk.length;
                return;
            }
            chunk.copy(this._packet, this._packetLength, 0, need);
            this._packetLength = 0;
            offset = need;
            if (this._packet[0] === SYNC_BYTE) {
                // the buffer is reused, the data must be copied
                this._onPacket(Buffer.from(this._packet));
            } else {
                this._onLost();
            }
        }

        while (offset + PACKET_SIZE <= chunk.length) {
            if (chunk[offset] !== SYNC_BYTE) {
                // resync
                ++offset;
                this._onLost();
                continue;
            }
            this._onPacket(chunk.subarray(offset, offset + PACKET_SIZE));
            offset += PACKET_SIZE;
        }

        if (offset < chunk.length) {
            chunk.copy(this._packet, 0, offset);
            this._packetLength = chunk.length - offset;
        }
    }
}

/**
 * assembles TLV from the TS packets of TLV (PID 0x2D).
 * Only the complete TLV packets are output, a TLV packet broken by a lost packet is dropped.
 */
export class TLVFramer {
    private _tlv: Buffer[] = [];
    private _tlvLength = 0;
    private _started = false;

    constructor(private _onLost?: () => void) {
    }

    /** @param packet a TS packet of TLV, `null` if lost */
    push(packet: Buffer | null, outputs: Buffer[]): void {
        if (packet === null || (packet[1] & 0x80) !== 0 || (((packet[1] & 0x1F) << 8) | packet[2]) !== TLV_PID) {
            if (packet !== null && (((packet[1] & 0x1F) << 8) | packet[2]) === NULL_PID) {
                return;
            }
            this.lost();
            return;
        }

        // the TS packets of TLV have no continuity_counter: the payload starts at 3, or at 4 after pointer_field
        const pusi = (packet[1] & 0x40) !== 0;
        let data = packet.subarray(pusi ? 4 : 3);

        if (this._started === false) {
            if (pusi === false) {
                return;
            }
            // the base of pointer_field differs by the sender, start at the one pointing TLV
            const pointer = packet[3];
            const start = [pointer, pointer - 1].find(i => i >= 0 && i < data.length && data[i] === TLV_SYNC_BYTE);
            if (start === undefined) {
                return;
            }
            data = data.subarray(start);
            this._started = true;
        }

        this._tlv.push(data);
        this._tlvLength += data.length;
        this._output(outputs);
    }

    /** drops the TLV packet in assembling, and starts again from the next start of a TLV packet */
    lost(): void {
        this._started = false;
        this._tlv = [];
        this._tlvLength = 0;
        this._onLost?.();
    }

    /**
     * moves the complete TLV packets to the outputs
     * (the data is kept as received until a TLV packet is complete, not to copy the rest again for each TS packet)
     */
    private _output(outputs: Buffer[]): void {
        while (this._tlvLength >= TLV_HEADER_SIZE) {
            const header = this._tlv[0].length >= TLV_HEADER_SIZE ? this._tlv[0] : Buffer.concat(this._tlv.slice(0, TLV_HEADER_SIZE));
            if (header[0] !== TLV_SYNC_BYTE) {
                // broken, wait for the next start
                this.lost();
                return;
            }
            const size = TLV_HEADER_SIZE + header.readUInt16BE(2);
            if (size > this._tlvLength) {
                return;
            }
            outputs.push(this._take(size));
        }
    }

    /** takes the bytes of a TLV packet from the head of the data kept */
    private _take(size: number): Buffer {
        const parts: Buffer[] = [];
        let rest = size;
        let used = 0;
        while (rest > 0) {
            const part = this._tlv[used];
            if (part.length <= rest) {
                parts.push(part);
                rest -= part.length;
                used++;
            } else {
                parts.push(part.subarray(0, rest));
                this._tlv[used] = part.subarray(rest);
                rest = 0;
            }
        }
        this._tlv.splice(0, used);
        this._tlvLength -= size;
        // the data is of the packets copied from the input chunk
        return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
    }
}

/**
 * assembles TLV of a relative stream from the slots of the TSMF frames (single carrier).
 */
export default class TSMFTLV {
    private _reader = new TSPacketReader(packet => this._onPacket(packet), () => this._framer.lost());
    private _framer = new TLVFramer();
    private _outputs: Buffer[] = [];

    private _slotMap: number[] = null;
    private _slotCounter = -1;
    /** the packets of the relative stream in the frame (the other slots are only counted) */
    private _frame: Buffer[] = [];
    private _headerCC = -1;
    private _warned = false;

    constructor(private _relTs: number) {
    }

    /** @returns TLV packets in the chunk (TS packets) */
    push(chunk: Buffer): Buffer {
        this._reader.push(chunk);

        const outputs = this._outputs;
        this._outputs = [];
        return outputs.length === 1 ? outputs[0] : Buffer.concat(outputs);
    }

    private _onPacket(packet: Buffer): void {
        const pid = ((packet[1] & 0x1F) << 8) | packet[2];

        if (pid === TSMF_PID) {
            this._onHeader(packet);
            return;
        }

        if (this._slotCounter < 0) {
            return;
        }
        // Wait for the next header before trusting the slot positions.
        if (++this._slotCounter <= SLOT_COUNT && this._slotMap[this._slotCounter - 1] === this._relTs) {
            // the input chunk is shared with the other users
            this._frame.push(Buffer.from(packet));
        }
    }

    private _onHeader(packet: Buffer): void {
        const frame = this._frame;
        this._frame = [];
        const header = parseTSMFHeader(packet);
        if (header === null) {
            this._slotCounter = -1;
            this._framer.lost();
            return;
        }

        // the frames between were lost (or the frame of the channel tuned before remains right after tuning)
        const cc = packet[3] & 0x0F;
        const continuous = this._headerCC !== -1 && cc === ((this._headerCC + 1) & 0x0F);
        this._headerCC = cc;
        if (continuous === false) {
            this._framer.lost();
            this._slotCounter = -1;
            return;
        }
        // the slots of the last frame were lost
        if (this._slotCounter !== -1 && this._slotCounter !== SLOT_COUNT) {
            this._framer.lost();
        }

        if (this._slotCounter === SLOT_COUNT) {
            for (const selected of frame) {
                this._framer.push(selected, this._outputs);
            }
        }

        // the frames of the carriers are interleaved, assembled by TSMFBonding
        // (the interleaving of the frames of a single carrier is the same order as the frames)
        if (isBondedStream(header, this._relTs) || isTLVStream(header, this._relTs) === false) {
            if (this._warned === false) {
                this._warned = true;
                log.warn(
                    "TSMFTLV: the relative stream %d is not TLV of a single carrier (numberOfCarriers=%d), `tsmfGroupId` may be needed",
                    this._relTs, header.numberOfCarriers
                );
            }
            this._slotCounter = -1;
            return;
        }

        this._slotMap = header.slotMap;
        this._slotCounter = 0;
    }
}
