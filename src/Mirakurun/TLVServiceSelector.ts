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
import { MMTPackageTable, PackageListTable, mmtPackageIdToServiceId } from "arib-mmt-tlv-ts/mmt-si.js";

const TLV_SYNC = 0x7F;
const TLV_IPV4 = 0x01;
const TLV_IPV6 = 0x02;
const TLV_COMPRESSED_IP = 0x03;
const TLV_CONTROL = 0xFE;
const TLV_NULL = 0xFF;

const MMTP_SIGNALLING = 0x02;
const PLT_PACKET_ID = 0x0000;
const MESSAGE_PA = 0x0000;
const TABLE_PLT = 0x80;
const NTP_PORT = 123;

/**
 * drops the packets of the services other than the one selected from TLV (MMT),
 * and rewrites PLT to list the selected service only, as TSFilter does with PAT.
 * PLT is rewritten only in the packets with the compressed IP header (no length in the header),
 * and not fragmented nor aggregated; otherwise PLT is passed as is.
 * The output is the TLV packets as a whole.
 */
export default class TLVServiceSelector {

    private _held: Buffer = null;
    /** service ID → packet ID of MPT */
    private _packages = new Map<number, number>();
    /** service ID → packet IDs of the assets */
    private _assets = new Map<number, number[]>();
    private _drop = new Set<number>();

    constructor(readonly serviceId: number) { }

    onPLT(plt: PackageListTable): void {
        const packages = new Map<number, number>();
        for (const pkg of plt.packages) {
            const serviceId = mmtPackageIdToServiceId(pkg.mmtPackageId);
            if (serviceId !== undefined && pkg.locationInfo?.locationType === "sameDataflow") {
                packages.set(serviceId, pkg.locationInfo.packetId);
            }
        }
        this._packages = packages;
        this._decide();
    }

    onMPT(mpt: MMTPackageTable): void {
        const serviceId = mmtPackageIdToServiceId(mpt.mmtPackageId);
        if (serviceId === undefined) {
            return;
        }
        const packetIds: number[] = [];
        for (const asset of mpt.assets) {
            for (const location of asset.locations) {
                if (location.locationType === "sameDataflow") {
                    packetIds.push(location.packetId);
                }
            }
        }
        const old = this._assets.get(serviceId);
        if (old && old.length === packetIds.length && old.every((id, i) => id === packetIds[i])) {
            return;
        }
        this._assets.set(serviceId, packetIds);
        this._decide();
    }

    /** @returns the TLV packets to output (complete ones only) */
    push(chunk: Buffer): Buffer {
        const buf = this._held ? Buffer.concat([this._held, chunk]) : chunk;
        this._held = null;

        const out: Buffer[] = [];
        // the range of the packets passed as is, output in a slice
        let passStart = -1;
        let pos = 0;
        while (pos + 4 <= buf.length) {
            if (isTlvPacketStart(buf, pos) === false) {
                if (passStart !== -1) {
                    out.push(buf.subarray(passStart, pos));
                    passStart = -1;
                }
                ++pos;
                continue;
            }
            const end = pos + 4 + buf.readUInt16BE(pos + 2);
            if (end > buf.length) {
                break;
            }
            const packet = buf.subarray(pos, end);
            const selected = this._select(packet);
            if (selected === packet) {
                if (passStart === -1) {
                    passStart = pos;
                }
            } else {
                if (passStart !== -1) {
                    out.push(buf.subarray(passStart, pos));
                    passStart = -1;
                }
                if (selected !== null) {
                    out.push(selected);
                }
            }
            pos = end;
        }
        if (passStart !== -1) {
            out.push(buf.subarray(passStart, pos));
        }
        if (pos < buf.length) {
            // 入力のチャンクは他の利用者と共有しているため、保持する分はコピーする
            this._held = Buffer.from(buf.subarray(pos));
        }

        return out.length === 1 ? out[0] : Buffer.concat(out);
    }

    private _decide(): void {
        const keep = new Set<number>();
        const drop = new Set<number>();
        for (const [serviceId, mptPacketId] of this._packages) {
            const target = serviceId === this.serviceId ? keep : drop;
            target.add(mptPacketId);
            for (const packetId of this._assets.get(serviceId) || []) {
                target.add(packetId);
            }
        }
        // PLT is rewritten, and the packet IDs shared with the selected service are kept
        drop.delete(PLT_PACKET_ID);
        for (const packetId of keep) {
            drop.delete(packetId);
        }
        this._drop = drop;
    }

    /** @returns the packet as is, a rewritten one, or `null` to drop */
    private _select(packet: Buffer): Buffer | null {
        const mmtp = getMMTPOffset(packet);
        if (mmtp === -1 || mmtp + 12 > packet.length) {
            return packet;
        }
        const packetId = packet.readUInt16BE(mmtp + 2);
        if (this._drop.has(packetId)) {
            return null;
        }
        if (packetId !== PLT_PACKET_ID || (packet[mmtp + 1] & 0x3F) !== MMTP_SIGNALLING) {
            return packet;
        }
        // the IP header compressed has no length to be rewritten
        if (packet[1] !== TLV_COMPRESSED_IP) {
            return packet;
        }
        const payload = getMMTPPayloadOffset(packet, mmtp);
        if (payload === -1) {
            return packet;
        }
        const rewritten = this._rewritePA(packet.subarray(payload));
        if (rewritten === null) {
            return packet;
        }
        const result = Buffer.concat([packet.subarray(0, payload), rewritten]);
        result.writeUInt16BE(result.length - 4, 2);
        return result;
    }

    /** rewrites PLT in the signalling message payload of PA message, `null` if not rewritten */
    private _rewritePA(payload: Buffer): Buffer | null {
        // not fragmented, not aggregated
        if (payload.length < 2 || payload[0] >> 6 !== 0 || (payload[0] & 0x01) !== 0) {
            return null;
        }
        const message = payload.subarray(2);
        if (message.length < 8 || message.readUInt16BE(0) !== MESSAGE_PA) {
            return null;
        }
        const extensionEnd = 7 + message.readUInt32BE(3);
        if (extensionEnd > message.length) {
            return null;
        }
        const extension = message.subarray(7, extensionEnd);
        const count = extension[0];
        const headerEnd = 1 + 4 * count;
        if (headerEnd > extension.length) {
            return null;
        }
        const header = Buffer.from(extension.subarray(0, headerEnd));
        const tables: Buffer[] = [];
        let changed = false;
        let pos = headerEnd;
        while (pos + 4 <= extension.length) {
            const end = pos + 4 + extension.readUInt16BE(pos + 2);
            if (end > extension.length) {
                return null;
            }
            const table = extension.subarray(pos, end);
            const rebuilt = table[0] === TABLE_PLT ? pltOnly(table, this.serviceId) : null;
            if (rebuilt !== null) {
                changed = true;
                const nth = tables.length;
                if (nth < count) {
                    header.writeUInt16BE(rebuilt.length - 4, 1 + 4 * nth + 2);
                }
            }
            tables.push(rebuilt || table);
            pos = end;
        }
        if (changed === false) {
            return null;
        }
        const newExtension = Buffer.concat([header, ...tables, extension.subarray(pos)]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(newExtension.length);
        return Buffer.concat([
            payload.subarray(0, 2),
            message.subarray(0, 3),
            length,
            newExtension,
            message.subarray(extensionEnd)
        ]);
    }
}

/** the TLV packet starts at `pos`, followed by another one or the end */
function isTlvPacketStart(buf: Buffer, pos: number): boolean {
    if (buf[pos] !== TLV_SYNC) {
        return false;
    }
    const type = buf[pos + 1];
    if (type !== TLV_IPV4 && type !== TLV_IPV6 && type !== TLV_COMPRESSED_IP && type !== TLV_CONTROL && type !== TLV_NULL) {
        return false;
    }
    const next = pos + 4 + buf.readUInt16BE(pos + 2);
    return next >= buf.length || buf[next] === TLV_SYNC;
}

/** the offset of MMTP packet in the TLV packet, `-1` if not MMTP (NTP etc.) */
function getMMTPOffset(packet: Buffer): number {
    switch (packet[1]) {
        case TLV_COMPRESSED_IP: {
            if (packet.length < 7) {
                return -1;
            }
            // CID (12 bits), SN (4 bits), CID_header_type (ARIB STD-B32)
            switch (packet[6]) {
                case 0x21:
                case 0x61:
                    return 7;
                case 0x20:
                    return 4 + 23;
                case 0x60:
                    return 4 + 45;
            }
            return -1;
        }
        case TLV_IPV4:
        case TLV_IPV6: {
            const ipHeader = packet[1] === TLV_IPV6 ? 40 : (packet[4] & 0x0F) * 4;
            const udp = 4 + ipHeader;
            if (udp + 8 > packet.length || packet.readUInt16BE(udp + 2) === NTP_PORT) {
                return -1;
            }
            return udp + 8;
        }
    }
    return -1;
}

/** the offset of the payload of MMTP packet, `-1` if broken */
function getMMTPPayloadOffset(packet: Buffer, mmtp: number): number {
    let pos = mmtp + 12;
    // packet_counter_flag
    if ((packet[mmtp] & 0x20) !== 0) {
        pos += 4;
    }
    // extension_flag
    if ((packet[mmtp] & 0x02) !== 0) {
        if (pos + 4 > packet.length) {
            return -1;
        }
        pos += 4 + packet.readUInt16BE(pos + 2);
    }
    return pos <= packet.length ? pos : -1;
}

/** PLT with the package of the service only, `null` if not found */
function pltOnly(table: Buffer, serviceId: number): Buffer | null {
    const body = table.subarray(4);
    if (body.length === 0) {
        return null;
    }
    const count = body[0];
    let pos = 1;
    let kept: Buffer = null;
    for (let i = 0; i < count; i++) {
        if (pos >= body.length) {
            return null;
        }
        const idLength = body[pos];
        const idEnd = pos + 1 + idLength;
        const locationSize = getLocationInfoSize(body, idEnd);
        if (locationSize === -1) {
            return null;
        }
        const end = idEnd + locationSize;
        if (idLength === 2 && body.readUInt16BE(pos + 1) === serviceId) {
            kept = body.subarray(pos, end);
        }
        pos = end;
    }
    if (kept === null) {
        return null;
    }
    const newBody = Buffer.concat([Buffer.from([1]), kept, body.subarray(pos)]);
    const result = Buffer.alloc(4);
    result[0] = table[0];
    result[1] = table[1];
    result.writeUInt16BE(newBody.length, 2);
    return Buffer.concat([result, newBody]);
}

/** the size of MMT_general_location_info, `-1` if unknown */
function getLocationInfoSize(buf: Buffer, pos: number): number {
    if (pos >= buf.length) {
        return -1;
    }
    let size: number;
    switch (buf[pos]) {
        case 0x00:
            size = 3;
            break;
        case 0x01:
            size = 13;
            break;
        case 0x02:
        case 0x04:
            size = 37;
            break;
        case 0x03:
            size = 7;
            break;
        case 0x05:
            if (pos + 1 >= buf.length) {
                return -1;
            }
            size = 2 + buf[pos + 1];
            break;
        default:
            return -1;
    }
    return pos + size <= buf.length ? size : -1;
}
