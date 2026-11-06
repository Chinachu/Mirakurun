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
import * as log from "./log";
import { SLOT_COUNT, TSMF_PID, TLVFramer, TSPacketReader, isTLVStream, parseTSMFHeader } from "./TSMFTLV";

/** the slots of the relative stream in a frame (`null` if the packet was lost) */
interface Frame {
    slotMap: number[];
    slots: (Buffer | null)[];
}

interface Superframe {
    numberOfFrames: number;
    frames: Frame[];
}

const TLV_TYPES = new Set([0x01, 0x02, 0x03, 0xFE, 0xFF]); // IPv4, IPv6, compressed IP, signalling, null
const COMPRESSED_IP_CID_TYPES = new Set([0x20, 0x21, 0x60, 0x61]);

/** super frames needed to find the alignment of the carriers */
const ALIGN_SUPERFRAMES = 10;
/** super frames assembled to check an alignment */
const ALIGN_CHECK_SUPERFRAMES = 30;
/** the ratio of the bytes of the valid TLV packets to accept an alignment */
const ALIGN_VALID_RATIO = 0.9;
/** the difference of the ratios to choose an alignment among the candidates */
const ALIGN_VALID_RATIO_MARGIN = 0.02;
/** compressed IP packets needed in the check */
const ALIGN_MIN_COMPRESSED_IP = 16;
/** the stream is closed after failing to find the alignment this times in a row */
const ALIGN_MAX_FAILURES = 3;
/** the maximum skew to check, including data buffered before the other tuners lock */
const MAX_SKEW = 60;
/** a short check rejects broken candidates before checking the full sample */
const ALIGN_PROBE_SUPERFRAMES = 2;
/** the super frames kept after the alignment (the carriers deliver them at different times) */
const KEEP_SUPERFRAMES = 2;
/** a carrier is stalled if the others are ahead by this super frames */
const MAX_AHEAD_SUPERFRAMES = 60;

/** receives the frames of a relative stream from a carrier (one tuner) */
class CarrierInput {
    readonly superframes: Superframe[] = [];
    carrierSequence = 0;
    numberOfCarriers = 0;

    private _reader = new TSPacketReader(packet => this._onPacket(packet), () => this._lost());
    private _superframe: Superframe = null;
    private _completed: Superframe = null;
    private _frame: Frame = null;
    private _slotCounter = -1;
    private _headerCC = -1;

    constructor(private _relTs: number, private _onLost: () => void, private _warn: (message: string) => void) {
    }

    push(chunk: Buffer): void {
        this._reader.push(chunk);
    }

    /** moves the super frame completed by the slots of the last frame to `superframes` */
    commit(): void {
        if (this._completed !== null && this._slotCounter === SLOT_COUNT) {
            this.superframes.push(this._completed);
            this._completed = null;
        }
    }

    private _onPacket(packet: Buffer): void {
        const pid = ((packet[1] & 0x1F) << 8) | packet[2];

        if (pid === TSMF_PID) {
            this._onHeader(packet);
            return;
        }

        if (this._frame === null || this._slotCounter >= SLOT_COUNT) {
            return;
        }
        const slot = this._slotCounter++;
        if (this._frame.slotMap[slot] === this._relTs) {
            // kept until all the carriers deliver the super frame, the input chunk is shared with the other users
            this._frame.slots[slot] = Buffer.from(packet);
        }
    }

    private _onHeader(packet: Buffer): void {
        const header = parseTSMFHeader(packet);
        if (header === null) {
            this._lost();
            return;
        }

        // the frames between were lost (or the frame of the channel tuned before remains right after tuning)
        const cc = packet[3] & 0x0F;
        const continuous = this._headerCC !== -1 && cc === ((this._headerCC + 1) & 0x0F);
        const slotsLost = this._frame !== null && this._slotCounter !== SLOT_COUNT;
        this._headerCC = cc;
        if (continuous === false) {
            this._lost();
            return;
        }
        if (slotsLost) {
            this._lost();
        } else {
            this.commit();
        }

        if (isTLVStream(header, this._relTs) === false) {
            this._warn(`the relative stream ${this._relTs} is not TLV`);
            return;
        }
        if (this.carrierSequence !== 0 && this.carrierSequence !== header.carrierSequence) {
            this._warn(`the carrier sequence has changed (${this.carrierSequence} -> ${header.carrierSequence})`);
            this._lost();
        }
        this.carrierSequence = header.carrierSequence;
        this.numberOfCarriers = header.numberOfCarriers;

        if (header.framePosition === 0) {
            this._superframe = { numberOfFrames: header.numberOfFrames, frames: [] };
        } else if (this._superframe === null || this._superframe.frames.length !== header.framePosition) {
            // wait for the next super frame
            this._superframe = null;
            this._frame = null;
            return;
        }

        this._frame = { slotMap: header.slotMap, slots: new Array(SLOT_COUNT).fill(null) };
        this._slotCounter = 0;
        this._superframe.frames.push(this._frame);

        if (this._superframe.frames.length === this._superframe.numberOfFrames) {
            // completed when the slots of the last frame are received
            this._completed = this._superframe;
            this._superframe = null;
        }
    }

    private _lost(): void {
        this._superframe = null;
        this._frame = null;
        this._completed = null;
        this._slotCounter = -1;
        this._onLost();
    }
}

/**
 * assembles TLV of a relative stream from the bonded carriers (channel bonding of CATV).
 * The super frames of the carriers are aligned by checking the TLV assembled, since the carriers are not synchronized.
 */
export default class TSMFBonding {
    private _inputs: CarrierInput[] = [];
    private _framer = new TLVFramer();
    private _offsets: number[] = null;
    private _failures = 0;
    private _nextAlignAt = ALIGN_SUPERFRAMES;
    private _warned = new Set<string>();
    private _closed = false;

    /**
     * @param numberOfInputs the tuners (carriers)
     * @param _onError called when the TLV can not be assembled any more
     */
    constructor(private _relTs: number, numberOfInputs: number, private _onError: (reason: string) => void) {
        for (let i = 0; i < numberOfInputs; i++) {
            this._inputs.push(new CarrierInput(_relTs, () => this._lost(), message => this._warn(message)));
        }
    }

    /** @returns TLV packets assembled */
    push(input: number, chunk: Buffer): Buffer {
        if (this._closed) {
            return Buffer.alloc(0);
        }
        const carrier = this._inputs[input];
        carrier.push(chunk);
        carrier.commit();

        const outputs: Buffer[] = [];
        this._assemble(outputs);
        return outputs.length === 1 ? outputs[0] : Buffer.concat(outputs);
    }

    close(): void {
        this._closed = true;
        this._inputs = [];
    }

    private _assemble(outputs: Buffer[]): void {
        const counts = this._inputs.map(carrier => carrier.superframes.length);
        if (Math.max(...counts) - Math.min(...counts) > MAX_AHEAD_SUPERFRAMES) {
            // a carrier has stalled or lost the super frames
            this._fail("a carrier has stalled");
            return;
        }

        // the carriers in carrier_sequence
        const carriers = this._inputs.filter(input => input.carrierSequence !== 0).sort((a, b) => a.carrierSequence - b.carrierSequence);
        if (carriers.length < this._inputs.length) {
            return;
        }
        if (carriers.some(carrier => carrier.numberOfCarriers !== this._inputs.length)) {
            this._closed = true;
            this._onError(`the number of carriers (${carriers[0].numberOfCarriers}) differs from the channels of the group (${this._inputs.length})`);
            return;
        }

        if (this._offsets === null) {
            if (Math.min(...counts) < this._nextAlignAt) {
                return;
            }
            this._offsets = this._align(carriers);
            if (this._offsets === null) {
                this._nextAlignAt = Math.min(...counts) + ALIGN_SUPERFRAMES;
                // Keep the samples so a larger skew can be checked as more data arrives.
                if (Math.min(...counts) >= MAX_SKEW + ALIGN_SUPERFRAMES) {
                    this._fail("can not align the carriers");
                }
                return;
            }
            this._failures = 0;
            carriers.forEach((carrier, i) => carrier.superframes.splice(0, this._offsets[i]));
            this._framer.lost();
        }

        const count = Math.min(...carriers.map(carrier => carrier.superframes.length)) - KEEP_SUPERFRAMES;
        for (let i = 0; i < count; i++) {
            this._forEachSlot(carriers.map(carrier => carrier.superframes[i]), packet => this._framer.push(packet, outputs));
        }
        if (count > 0) {
            for (const carrier of carriers) {
                carrier.superframes.splice(0, count);
            }
        }
    }

    /** the slots of the super frames of the carriers in the order of the TLV */
    private _forEachSlot(superframes: Superframe[], callback: (packet: Buffer | null) => boolean | void): void {
        const maxFrames = Math.max(...superframes.map(sf => sf.numberOfFrames));

        // a super frame is interleaved by the slots (including the header) of the frames, then by the carriers
        for (let sub = 0; sub < SLOT_COUNT + 1; sub++) {
            for (let position = 0; position < maxFrames; position++) {
                for (const sf of superframes) {
                    const n = sf.numberOfFrames;
                    if (position >= n) {
                        continue;
                    }
                    const index = sub * n + position;
                    const frame = sf.frames[Math.floor(index / (SLOT_COUNT + 1))];
                    const slot = index % (SLOT_COUNT + 1) - 1;
                    if (frame === undefined || slot < 0 || frame.slotMap[slot] !== this._relTs) {
                        continue;
                    }
                    if (callback(frame.slots[slot]) === false) {
                        return;
                    }
                }
            }
        }
    }

    /** finds the offsets of the super frames of the carriers which assemble the valid TLV */
    private _align(carriers: CarrierInput[]): number[] | null {
        const counts = carriers.map(carrier => carrier.superframes.length);
        // Queue lengths reflect delivery timing, not the positions in the broadcast stream.
        const maxOffsets = counts.map(count => Math.min(MAX_SKEW, Math.max(0, count - ALIGN_SUPERFRAMES)));
        const results: { offsets: number[], ratio: number }[] = [];
        const offsets = counts.map(() => 0);
        // The first zero offset identifies each normalized candidate exactly once.
        const visit = (index: number, firstZero: number): void => {
            if (index === carriers.length) {
                if (this._checkAlignment(carriers, offsets, ALIGN_PROBE_SUPERFRAMES, 0) !== null) {
                    const ratio = this._checkAlignment(carriers, offsets, ALIGN_CHECK_SUPERFRAMES);
                    if (ratio !== null) {
                        results.push({ offsets: offsets.slice(), ratio });
                    }
                }
                return;
            }
            if (index === firstZero) {
                offsets[index] = 0;
                visit(index + 1, firstZero);
                return;
            }
            for (let offset = index < firstZero ? 1 : 0; offset <= maxOffsets[index]; offset++) {
                offsets[index] = offset;
                visit(index + 1, firstZero);
            }
        };
        for (let firstZero = 0; firstZero < carriers.length; firstZero++) {
            visit(0, firstZero);
        }

        if (results.length === 0) {
            return null;
        }
        results.sort((a, b) => b.ratio - a.ratio);
        if (results.length > 1 && results[0].ratio - results[1].ratio < ALIGN_VALID_RATIO_MARGIN) {
            // ambiguous, check with more super frames
            return null;
        }
        log.debug("TSMFBonding: aligned the carriers (offsets=%s, valid=%s%%)", results[0].offsets.join(","), (results[0].ratio * 100).toFixed(2));
        return results[0].offsets;
    }

    private _checkAlignment(carriers: CarrierInput[], offsets: number[], maxSuperframes: number, minCompressedIP = ALIGN_MIN_COMPRESSED_IP): number | null {
        const count = Math.min(maxSuperframes, ...carriers.map((carrier, i) => carrier.superframes.length - offsets[i]));
        if (count <= 0) {
            return null;
        }
        let intact = true;
        const framer = new TLVFramer(() => intact = false);
        const outputs: Buffer[] = [];
        let total = 0;
        for (let sf = 0; sf < count; sf++) {
            this._forEachSlot(carriers.map((carrier, i) => carrier.superframes[offsets[i] + sf]), packet => {
                if (packet !== null) {
                    total += packet.length - 4;
                }
                framer.push(packet, outputs);
                // A wrong skew can produce valid packets after resynchronizing; reject it instead.
                return intact;
            });
            if (!intact) {
                return null;
            }
        }
        return checkTLV(Buffer.concat(outputs), total, minCompressedIP);
    }

    private _lost(): void {
        // a lost super frame shifts the alignment of the carrier
        if (this._offsets !== null) {
            this._offsets = null;
            this._nextAlignAt = ALIGN_SUPERFRAMES;
            for (const input of this._inputs) {
                input.superframes.length = 0;
            }
        }
        this._framer.lost();
    }

    private _fail(reason: string): void {
        this._offsets = null;
        ++this._failures;
        if (this._failures >= ALIGN_MAX_FAILURES) {
            this._closed = true;
            this._onError(reason);
            return;
        }
        log.warn("TSMFBonding: %s, aligning the carriers again (%d/%d)", reason, this._failures, ALIGN_MAX_FAILURES);
        for (const input of this._inputs) {
            input.superframes.length = 0;
        }
        this._nextAlignAt = ALIGN_SUPERFRAMES;
    }

    private _warn(message: string): void {
        if (this._warned.has(message) === false) {
            this._warned.add(message);
            log.warn("TSMFBonding: %s", message);
        }
    }
}

/**
 * @param total the bytes of the TLV data assembled
 * @returns the ratio of the valid TLV packets, `null` if not valid
 */
function checkTLV(tlv: Buffer, total: number, minCompressedIP: number): number | null {
    let pos = 0;
    let compressedIP = 0;
    while (pos + 4 <= tlv.length) {
        const type = tlv[pos + 1];
        const length = tlv.readUInt16BE(pos + 2);
        if (tlv[pos] !== 0x7F || TLV_TYPES.has(type) === false) {
            return null;
        }
        if (type === 0x03 && length >= 3) {
            if (COMPRESSED_IP_CID_TYPES.has(tlv[pos + 4 + 2]) === false) {
                return null;
            }
            ++compressedIP;
        }
        pos += 4 + length;
    }
    if (compressedIP < minCompressedIP) {
        return null;
    }
    const ratio = tlv.length / Math.max(total, 1);
    return ratio >= ALIGN_VALID_RATIO ? ratio : null;
}
