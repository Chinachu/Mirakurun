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

const PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;
const TSMF_PID = 0x2F;
const TLV_PID = 0x2D;
const NULL_PID = 0x1FFF;
const SLOT_COUNT = 52;
const TSMF_FRAME_SYNC = [0x1A86, 0x0579];

const TLV_SYNC_BYTE = 0x7F;
const TLV_HEADER_SIZE = 4;

/** the header of a TSMF frame (ARIB STD-B32 / JCTEA STD-002) */
export interface TSMFHeader {
    /** relative stream number of each slot (0 = unused) */
    slotMap: number[];
    /** bit of relative stream n (MSB = 1): 0 = TLV, 1 = TS */
    streamTypeBits: number;
    numberOfCarriers: number;
}

export function parseTSMFHeader(packet: Buffer): TSMFHeader | null {
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

    // frame_type 0x2 (multi-carrier) has the number of carriers, but it may be 1
    const frameType = payload[2] & 0x0F;

    return {
        slotMap,
        streamTypeBits: (payload[121] << 7) | (payload[122] >> 1),
        numberOfCarriers: frameType === 0x02 ? payload[124] : 1
    };
}

/**
 * assembles TLV of a relative stream from the slots of the TSMF frames (single carrier).
 * Only the complete TLV packets are output, a TLV packet broken by a lost packet is dropped.
 */
export default class TSMFTLV {
    // the remainder of the last chunk
    private _packet = Buffer.allocUnsafe(PACKET_SIZE);
    private _packetLength = 0;

    private _slotMap: number[] = null;
    private _slotCounter = -1;
    private _frame: Buffer[] = [];
    private _headerCC = -1;
    private _warned = false;

    // TLV
    private _tlv: Buffer[] = [];
    private _tlvLength = 0;
    private _tlvStarted = false;

    constructor(private _relTs: number) {
    }

    /** @returns TLV packets in the chunk (TS packets) */
    push(chunk: Buffer): Buffer {
        const outputs: Buffer[] = [];
        let offset = 0;

        if (this._packetLength > 0) {
            const need = PACKET_SIZE - this._packetLength;
            if (chunk.length < need) {
                chunk.copy(this._packet, this._packetLength);
                this._packetLength += chunk.length;
                return Buffer.alloc(0);
            }
            chunk.copy(this._packet, this._packetLength, 0, need);
            this._packetLength = 0;
            offset = need;
            if (this._packet[0] === SYNC_BYTE) {
                // the buffer is reused, the data must be copied
                this._onPacket(Buffer.from(this._packet), outputs);
            }
        }

        while (offset + PACKET_SIZE <= chunk.length) {
            if (chunk[offset] !== SYNC_BYTE) {
                // resync
                ++offset;
                this._lost();
                continue;
            }
            this._onPacket(chunk.subarray(offset, offset + PACKET_SIZE), outputs);
            offset += PACKET_SIZE;
        }

        if (offset < chunk.length) {
            chunk.copy(this._packet, 0, offset);
            this._packetLength = chunk.length - offset;
        }

        return outputs.length === 1 ? outputs[0] : Buffer.concat(outputs);
    }

    private _onPacket(packet: Buffer, outputs: Buffer[]): void {
        const pid = ((packet[1] & 0x1F) << 8) | packet[2];

        if (pid === TSMF_PID) {
            this._onHeader(packet, outputs);
            return;
        }
        if (this._slotCounter < 0) {
            return;
        }
        // A missing whole packet shifts every subsequent slot. Do not emit until
        // the next header confirms both the frame length and continuity.
        if (++this._slotCounter <= SLOT_COUNT) {
            this._frame.push(Buffer.from(packet));
        }
    }

    private _onSelectedPacket(packet: Buffer, outputs: Buffer[]): void {
        const pid = ((packet[1] & 0x1F) << 8) | packet[2];
        if ((packet[1] & 0x80) !== 0) {
            // transport_error_indicator
            this._lost();
            return;
        }
        if (pid === TLV_PID) {
            this._onTLVPacket(packet, outputs);
        } else if (pid !== NULL_PID) {
            this._lost();
        }
    }

    private _onHeader(packet: Buffer, outputs: Buffer[]): void {
        const frame = this._frame;
        this._frame = [];
        const header = (packet[1] & 0x80) === 0 ? parseTSMFHeader(packet) : null;
        if (header === null) {
            this._slotCounter = -1;
            this._lost();
            return;
        }

        // the frames between were lost (or the frame of the channel tuned before remains right after tuning)
        const cc = packet[3] & 0x0F;
        const continuous = this._headerCC !== -1 && cc === ((this._headerCC + 1) & 0x0F);
        this._headerCC = cc;
        if (continuous === false) {
            this._lost();
            this._slotCounter = -1;
            return;
        }
        // the slots of the last frame were lost
        if (this._slotCounter !== -1 && this._slotCounter !== SLOT_COUNT) {
            this._lost();
        }

        if (this._slotCounter === SLOT_COUNT) {
            for (let i = 0; i < frame.length; i++) {
                if (this._slotMap[i] === this._relTs) {
                    this._onSelectedPacket(frame[i], outputs);
                }
            }
        }

        if (header.numberOfCarriers > 1) {
            if (this._warned === false) {
                this._warned = true;
                log.warn("TSMFTLV: the multi-carrier TSMF is not supported (numberOfCarriers=%d)", header.numberOfCarriers);
            }
            this._slotCounter = -1;
            return;
        }
        if (((header.streamTypeBits >> (15 - this._relTs)) & 1) !== 0) {
            if (this._warned === false) {
                this._warned = true;
                log.warn("TSMFTLV: the relative stream %d is not TLV", this._relTs);
            }
            this._slotCounter = -1;
            return;
        }

        this._slotMap = header.slotMap;
        this._slotCounter = 0;
    }

    private _onTLVPacket(packet: Buffer, outputs: Buffer[]): void {
        // the TS packets of TLV have no continuity_counter: the payload starts at 3, or at 4 after pointer_field
        const pusi = (packet[1] & 0x40) !== 0;
        let data = packet.subarray(pusi ? 4 : 3);

        if (this._tlvStarted === false) {
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
            this._tlvStarted = true;
        }

        this._tlv.push(data);
        this._tlvLength += data.length;
        this._outputTLV(outputs);
    }

    /** moves the complete TLV packets to the outputs */
    private _outputTLV(outputs: Buffer[]): void {
        let buffer = this._tlv.length === 1 ? this._tlv[0] : Buffer.concat(this._tlv, this._tlvLength);
        let end = 0;
        while (end + TLV_HEADER_SIZE <= buffer.length) {
            if (buffer[end] !== TLV_SYNC_BYTE) {
                // broken, wait for the next start
                this._lost();
                if (end > 0) {
                    outputs.push(Buffer.from(buffer.subarray(0, end)));
                }
                return;
            }
            const next = end + TLV_HEADER_SIZE + buffer.readUInt16BE(end + 2);
            if (next > buffer.length) {
                break;
            }
            end = next;
        }

        if (end > 0) {
            // the input chunk is shared with the other users
            outputs.push(Buffer.from(buffer.subarray(0, end)));
            buffer = buffer.subarray(end);
        }
        this._tlv = buffer.length > 0 ? [buffer] : [];
        this._tlvLength = buffer.length;
    }

    /** drops the TLV packet in assembling, and starts again from the next start of a TLV packet */
    private _lost(): void {
        this._tlvStarted = false;
        this._tlv = [];
        this._tlvLength = 0;
    }
}
