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
import { performance } from "perf_hooks";
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
    /** a frame is lost after a broken header (kept only while the carriers are aligned) */
    lost?: true;
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
/** the offsets within this super frames of the ones by the times received are checked first (the tuners started at different times) */
const ALIGN_NEAR = 8;
/** the super frames kept to find the alignment */
const ALIGN_SAMPLE_SUPERFRAMES = MAX_SKEW + ALIGN_CHECK_SUPERFRAMES;
/** the candidates of the offsets checked until all the skews can be checked (the more ones are checked once with all the skews) */
const ALIGN_EARLY_CANDIDATES = 20000;
/** the super frames kept after the alignment (the carriers deliver them at different times) */
const KEEP_SUPERFRAMES = 2;
/** the alignment is found again if the other carriers are ahead of a carrier by this super frames */
const MAX_AHEAD_SUPERFRAMES = 60;
/** a carrier is stalled if the others deliver this super frames each without it (about 10 seconds, including starting the tuner) */
const STALL_SUPERFRAMES = 1200;
/**
 * the stream is closed if not aligned while the carriers deliver this super frames each (about 30 seconds),
 * and the losses have interrupted finding the alignment `ALIGN_MAX_FAILURES` times in a row
 */
const ALIGN_TIMEOUT_SUPERFRAMES = 3600;

/** receives the frames of a relative stream from a carrier (one tuner) */
class CarrierInput {
    readonly superframes: Superframe[] = [];
    /** the super frames removed from `superframes` */
    removed = 0;
    /** the super frames delivered ahead of the carrier delivering last, when the alignment was lost */
    lead = 0;
    /** `-1` until the header is received */
    carrierSequence = -1;
    numberOfCarriers = 0;

    private _reader = new TSPacketReader(packet => this._onPacket(packet), () => this._lost());
    private _superframe: Superframe = null;
    private _completed: Superframe = null;
    private _frame: Frame = null;
    private _slotCounter = -1;
    private _headerCC = -1;
    /** number_of_frames of the header received last */
    private _numberOfFrames = 0;
    /** the frame after a broken header is in `_frame` */
    private _afterBroken = false;

    /** @param _isAligned whether the super frames of the carriers are aligned (a frame lost keeps the alignment) */
    constructor(private _relTs: number, private _onLost: () => void, private _warn: (message: string) => void, private _isAligned: () => boolean) {
    }

    push(chunk: Buffer): void {
        this._reader.push(chunk);
    }

    /** removes the super frames from the start of `superframes` */
    drop(count: number): void {
        this.superframes.splice(0, count);
        this.removed += count;
    }

    /** moves the super frame completed by the slots of the last frame to `superframes` */
    commit(): void {
        if (this._completed !== null && this._slotCounter === SLOT_COUNT) {
            const completed = this._completed;
            this._completed = null;
            // the alignment has been lost after the broken header (the frame lost would fail finding the alignment)
            if (completed.lost === true && this._isAligned() === false) {
                this._lost();
                return;
            }
            this.superframes.push(completed);
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
            this._onBrokenHeader();
            return;
        }
        this._afterBroken = false;

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
        if (this.carrierSequence !== -1 && this.carrierSequence !== header.carrierSequence) {
            this._warn(`the carrier sequence has changed (${this.carrierSequence} -> ${header.carrierSequence})`);
            this._lost();
        }
        this.carrierSequence = header.carrierSequence;
        this.numberOfCarriers = header.numberOfCarriers;
        this._numberOfFrames = header.numberOfFrames;

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

    /**
     * a header broken (CRC, transport_error_indicator): the frame after it is lost, keeping the super frames aligned
     * (the next header continues by continuity_counter + 2, a header broken right after a broken one is not taken as a header).
     * The super frames are dropped while not aligned (the frame lost would fail the check of the alignment).
     */
    private _onBrokenHeader(): void {
        if (this._frame === null || this._slotCounter !== SLOT_COUNT || this._headerCC === -1 || this._afterBroken || this._isAligned() === false) {
            this._headerCC = -1;
            this._afterBroken = false;
            this._lost();
            return;
        }
        this.commit();
        this._headerCC = (this._headerCC + 1) & 0x0F;
        this._afterBroken = true;

        // the frame of the next position (the packets are not read), all the slots are lost
        // (not by the slots of the frame before it: the slots may have changed, a slot of the stream not lost would join the TLV packets across it)
        this._superframe ??= { numberOfFrames: this._numberOfFrames, frames: [] };
        this._superframe.lost = true;
        this._frame = { slotMap: new Array(SLOT_COUNT).fill(this._relTs), slots: new Array(SLOT_COUNT).fill(null) };
        this._superframe.frames.push(this._frame);
        if (this._superframe.frames.length === this._superframe.numberOfFrames) {
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
    /** CPU time to find the alignment for each super frame of the carriers (not to block the other streams) */
    static alignSliceMs = 2;

    private _inputs: CarrierInput[] = [];
    private _framer = new TLVFramer();
    private _offsets: number[] = null;
    private _failures = 0;
    private _nextAlignAt = ALIGN_SUPERFRAMES;
    /** the super frames received from all the carriers */
    private _received = 0;
    /** `_received` when each carrier delivered a super frame last */
    private _lastReceived: number[] = [];
    /** `_received` when the alignment was lost */
    private _unalignedAt = 0;
    /** the losses since a search of the alignment has finished */
    private _interruptions = 0;
    /** finding the alignment in the samples of the super frames */
    private _search: { iterator: Iterator<void, number[] | null>, samples: Superframe[][], removed: number[] } = null;
    private _nextSliceAt = 0;
    private _warned = new Set<string>();
    private _closed = false;

    /**
     * @param numberOfInputs the tuners (carriers)
     * @param _onError called when the TLV can not be assembled any more
     */
    constructor(private _relTs: number, numberOfInputs: number, private _onError: (reason: string) => void) {
        for (let i = 0; i < numberOfInputs; i++) {
            const input: CarrierInput = new CarrierInput(_relTs, () => this._lost(input), message => this._warn(message), () => this._offsets !== null);
            this._inputs.push(input);
            this._lastReceived.push(0);
        }
    }

    /** @returns TLV packets assembled */
    push(input: number, chunk: Buffer): Buffer {
        if (this._closed) {
            return Buffer.alloc(0);
        }
        const carrier = this._inputs[input];
        const received = carrier.superframes.length;
        carrier.push(chunk);
        if (this._closed) {
            return Buffer.alloc(0);
        }
        carrier.commit();
        // closed by the super frame with the frame lost after the alignment has been lost
        if (this._closed) {
            return Buffer.alloc(0);
        }
        if (carrier.superframes.length > received) {
            this._received += carrier.superframes.length - received;
            this._lastReceived[input] = this._received;
        }

        const outputs: Buffer[] = [];
        this._assemble(outputs);
        return outputs.length === 1 ? outputs[0] : Buffer.concat(outputs);
    }

    close(): void {
        this._closed = true;
        this._inputs = [];
    }

    private _assemble(outputs: Buffer[]): void {
        // the tuner of the carrier has not started, or has stopped
        if (this._lastReceived.some(last => this._received - last > STALL_SUPERFRAMES * (this._inputs.length - 1))) {
            this._closed = true;
            this._onError("a carrier has stalled");
            return;
        }

        const counts = this._inputs.map(carrier => carrier.superframes.length);
        if (this._offsets === null) {
            this._trim(Math.min(...counts));
        } else if (Math.max(...counts) - Math.min(...counts) > MAX_AHEAD_SUPERFRAMES) {
            // a carrier has lagged or lost the super frames
            this._fail("a carrier has stalled");
            return;
        }

        // the carriers in carrier_sequence
        const carriers = this._inputs.filter(input => input.carrierSequence !== -1).sort((a, b) => a.carrierSequence - b.carrierSequence);
        if (carriers.length < this._inputs.length) {
            return;
        }
        if (carriers.some(carrier => carrier.numberOfCarriers !== this._inputs.length)) {
            this._closed = true;
            this._onError(`the number of carriers (${carriers[0].numberOfCarriers}) differs from the channels of the group (${this._inputs.length})`);
            return;
        }
        if (new Set(carriers.map(carrier => carrier.carrierSequence)).size !== carriers.length) {
            this._closed = true;
            this._onError(`the channels of the group receive the same carrier (carrier_sequence: ${carriers.map(carrier => carrier.carrierSequence).join(", ")})`);
            return;
        }

        if (this._offsets === null) {
            const offsets = this._findAlignment(carriers, Math.min(...counts));
            if (offsets === null) {
                return;
            }
            this._offsets = offsets;
            this._failures = 0;
            carriers.forEach((carrier, i) => carrier.drop(offsets[i]));
            this._framer.lost();
        }

        const count = Math.min(...carriers.map(carrier => carrier.superframes.length)) - KEEP_SUPERFRAMES;
        for (let i = 0; i < count; i++) {
            this._forEachSlot(carriers.map(carrier => carrier.superframes[i]), packet => this._framer.push(packet, outputs));
        }
        if (count > 0) {
            for (const carrier of carriers) {
                carrier.drop(count);
            }
        }
    }

    /**
     * finds the alignment in the slices of CPU time for the super frames received
     * @param min the super frames of the carrier started last
     * @returns the super frames of `carriers` to drop to align them, `null` if not found yet
     */
    private _findAlignment(carriers: CarrierInput[], min: number): number[] | null {
        if (this._search === null) {
            if (min < this._nextAlignAt) {
                return null;
            }
            // the super frames are dropped while finding (not to keep them for long)
            const samples = carriers.map(carrier => carrier.superframes.slice(0, ALIGN_SAMPLE_SUPERFRAMES));
            const leads = carriers.map(carrier => carrier.lead);
            this._search = { iterator: this._align(samples, leads), samples, removed: carriers.map(carrier => carrier.removed) };
            this._nextSliceAt = this._received;
        }
        if (this._received < this._nextSliceAt) {
            return null;
        }
        this._nextSliceAt = this._received + this._inputs.length;

        const deadline = performance.now() + TSMFBonding.alignSliceMs;
        let result: IteratorResult<void, number[] | null>;
        do {
            result = this._search.iterator.next();
        } while (result.done !== true && performance.now() < deadline);
        if (result.done !== true) {
            return null;
        }

        const { samples, removed } = this._search;
        this._search = null;
        this._interruptions = 0;
        this._nextAlignAt = Math.min(min + ALIGN_SUPERFRAMES, ALIGN_SAMPLE_SUPERFRAMES);
        const found = result.value;
        if (found === null) {
            // all the skews have been checked
            if (Math.min(...samples.map(sample => sample.length)) >= MAX_SKEW + ALIGN_SUPERFRAMES) {
                this._fail("can not align the carriers");
            }
            return null;
        }

        // the same alignment from the super frames not dropped yet
        const dropped = carriers.map((carrier, i) => carrier.removed - removed[i]);
        const shift = Math.max(0, ...found.map((offset, i) => dropped[i] - offset));
        const offsets = found.map((offset, i) => offset + shift - dropped[i]);
        if (offsets.some((offset, i) => offset >= carriers[i].superframes.length)) {
            return null;
        }
        return offsets;
    }

    /**
     * drops the super frames received before the other carriers started (they can not be aligned),
     * keeping the skews to check
     * @param min the super frames of the carrier started last
     */
    private _trim(min: number): void {
        const limit = Math.min(MAX_SKEW + ALIGN_CHECK_SUPERFRAMES, min + MAX_SKEW);
        for (const input of this._inputs) {
            if (input.superframes.length > limit) {
                input.drop(input.superframes.length - limit);
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

    /**
     * finds the offsets of the super frames of the carriers which assemble the valid TLV (yields for each candidate)
     * @param leads the super frames delivered ahead before the alignment was lost
     */
    private *_align(samples: Superframe[][], leads: number[]): Generator<void, number[] | null> {
        const counts = samples.map(sample => sample.length);
        const maxOffsets = counts.map(count => Math.min(MAX_SKEW, Math.max(0, count - ALIGN_SUPERFRAMES)));
        const min = Math.min(...counts);
        const estimates = [
            // the tuners started at different times: the super frames received since the carrier started last
            counts.map(count => count - min),
            // the alignment lost: the carriers delivering later received the older super frames since then
            leads.map(lead => Math.max(...leads) - lead)
        ];
        for (const estimate of estimates) {
            const near = yield* this._alignIn(
                samples,
                estimate.map((offset, i) => Math.min(Math.max(0, offset - ALIGN_NEAR), maxOffsets[i])),
                estimate.map((offset, i) => Math.min(offset + ALIGN_NEAR, maxOffsets[i]))
            );
            if (near !== null) {
                return near;
            }
        }

        // Queue lengths reflect delivery timing, not always the positions in the broadcast stream.
        const from = counts.map(() => 0);
        if (min < MAX_SKEW + ALIGN_SUPERFRAMES && countNormalizedOffsets(from, maxOffsets) > ALIGN_EARLY_CANDIDATES) {
            return null;
        }
        return yield* this._alignIn(samples, from, maxOffsets);
    }

    /** @returns the offsets in the ranges which assemble the valid TLV, `null` if not found or ambiguous */
    private *_alignIn(samples: Superframe[][], from: number[], to: number[]): Generator<void, number[] | null> {
        const results: { offsets: number[], ratio: number }[] = [];
        for (const offsets of normalizedOffsets(from, to)) {
            if (this._checkAlignment(samples, offsets, ALIGN_PROBE_SUPERFRAMES, 0) !== null) {
                const ratio = this._checkAlignment(samples, offsets, ALIGN_CHECK_SUPERFRAMES);
                if (ratio !== null) {
                    results.push({ offsets: offsets.slice(), ratio });
                }
            }
            yield;
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

    private _checkAlignment(samples: Superframe[][], offsets: number[], maxSuperframes: number, minCompressedIP = ALIGN_MIN_COMPRESSED_IP): number | null {
        const count = Math.min(maxSuperframes, ...samples.map((sample, i) => sample.length - offsets[i]));
        if (count <= 0) {
            return null;
        }
        let intact = true;
        const framer = new TLVFramer(() => intact = false);
        const outputs: Buffer[] = [];
        let total = 0;
        for (let sf = 0; sf < count; sf++) {
            this._forEachSlot(samples.map((sample, i) => sample[offsets[i] + sf]), packet => {
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

    private _lost(carrier: CarrierInput): void {
        if (this._closed) {
            return;
        }
        // a lost super frame shifts the alignment of the carrier
        if (this._offsets !== null) {
            const min = Math.min(...this._inputs.map(input => input.superframes.length));
            for (const input of this._inputs) {
                input.lead = input.superframes.length - min;
            }
            this._offsets = null;
            this._unalignedAt = this._received;
            this._nextAlignAt = ALIGN_SUPERFRAMES;
            for (const input of this._inputs) {
                input.drop(input.superframes.length);
            }
        } else {
            // the losses keep interrupting finding the alignment (not by the time to find, which depends on the CPU)
            // (once for the bytes skipped to resync or the next header of a broken one, the super frames of the carrier have been dropped)
            if (carrier.superframes.length > 0 || this._search !== null) {
                ++this._interruptions;
            }
            if (this._interruptions >= ALIGN_MAX_FAILURES && this._received - this._unalignedAt > ALIGN_TIMEOUT_SUPERFRAMES * this._inputs.length) {
                this._closed = true;
                this._onError("can not align the carriers");
                return;
            }
            // the super frames before the loss do not continue to the later ones (aligned by them, the later ones are misaligned)
            carrier.drop(carrier.superframes.length);
        }
        this._search = null;
        this._framer.lost();
    }

    private _fail(reason: string): void {
        if (this._offsets !== null) {
            this._unalignedAt = this._received;
        }
        this._offsets = null;
        this._search = null;
        ++this._failures;
        if (this._failures >= ALIGN_MAX_FAILURES) {
            this._closed = true;
            this._onError(reason);
            return;
        }
        log.warn("TSMFBonding: %s, aligning the carriers again (%d/%d)", reason, this._failures, ALIGN_MAX_FAILURES);
        for (const input of this._inputs) {
            input.drop(input.superframes.length);
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
 * the offsets in the ranges, one of them is 0 (the others are relative to it)
 * (the same array is yielded with the next offsets)
 */
function* normalizedOffsets(from: number[], to: number[]): Generator<number[]> {
    for (const { lower, upper } of normalizedRanges(from, to)) {
        const offsets = lower.slice();
        while (true) {
            yield offsets;
            let i = offsets.length - 1;
            while (i >= 0 && offsets[i] === upper[i]) {
                offsets[i] = lower[i];
                i--;
            }
            if (i < 0) {
                break;
            }
            offsets[i]++;
        }
    }
}

function countNormalizedOffsets(from: number[], to: number[]): number {
    let count = 0;
    for (const { lower, upper } of normalizedRanges(from, to)) {
        count += lower.reduce((product, offset, i) => product * (upper[i] - offset + 1), 1);
    }
    return count;
}

/** the ranges of the offsets for each of the offsets to be 0 (the offsets before it are not 0, counted by the zero before) */
function normalizedRanges(from: number[], to: number[]): { lower: number[], upper: number[] }[] {
    const ranges: { lower: number[], upper: number[] }[] = [];
    for (let zero = 0; zero < from.length; zero++) {
        if (from[zero] !== 0) {
            continue;
        }
        const lower = from.map((offset, i) => i === zero ? 0 : i < zero ? Math.max(offset, 1) : offset);
        const upper = to.map((offset, i) => i === zero ? 0 : offset);
        if (lower.every((offset, i) => offset <= upper[i])) {
            ranges.push({ lower, upper });
        }
    }
    return ranges;
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
