/*
   Copyright 2016 kanreisa
   Copyright 2024 otya
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
import { Writable } from "stream";
import EventEmitter = require("eventemitter3");
import { StreamInfo, getEpgStreamKey } from "./common";
import * as log from "./log";
import { retainOutput } from "./OutputBuffer";
import status from "./status";
import _ from "./_";
import { getProgramItemId } from "./Program";
import Service from "./Service";
import type ServiceItem from "./ServiceItem";
import MHEPG from "./MHEPG";
import EPGState from "./EPGState";
import TLVServiceSelector from "./TLVServiceSelector";
import TSMFTLV from "./TSMFTLV";
import TSMFBonding from "./TSMFBonding";
import { MMTTLVReader, createMMTTLVReader } from "arib-mmt-tlv-ts";
import type { MMTPReader } from "arib-mmt-tlv-ts/mmtp.js";
import { calculateCRC32 } from "arib-mmt-tlv-ts/crc-32.js";
import {
    MHEventInformationTable,
    MHServiceDescriptionTable,
    MHTimeOffsetTable,
    MMTPackageTable,
    PackageListTable,
    mmtPackageIdToServiceId,
    MHCommonDataTable,
    MH_CDT_DATA_TYPE_LOGO_DATA,
    MH_CDT_LOGO_TYPE_LARGE
} from "arib-mmt-tlv-ts/mmt-si.js";
import { TLVNetworkInformationTable, readTLVSI } from "arib-mmt-tlv-ts/tlv-si.js";
import { MH_LOGO_TRANSMISSION_TYPE_DIRECT } from "arib-mmt-tlv-ts/mmt-si-descriptor.js";
import { mjdBCDToUnixEpoch } from "arib-mmt-tlv-ts/utils.js";

export interface TLVFilterOptions {
    readonly output?: Writable;
    readonly networkId?: number;
    readonly serviceId?: number;
    readonly eventId?: number;
    readonly parseNIT?: boolean;
    readonly parseSDT?: boolean;
    readonly parseEIT?: boolean;
    /** the relative stream of TLV in TSMF (the input is TS) */
    readonly tsmfRelTs?: number;
    /** the bonded carriers (the inputs by `write()` and `writeCarrier()`) */
    readonly tsmfCarriers?: number;
}

// TSFilterのロゴダウンロードと同じ保持上限。
const MAX_LOGO_DATA_BYTES = 16 * 1024 * 1024;
const MAX_LOGO_DOWNLOADS = 64;

const textDecoder = new TextDecoder();
function decodeUTF8(buffer: Uint8Array): string {
    return textDecoder.decode(buffer, { stream: false });
}

/** table_idからCRC_32末尾までを検証する (ARIB STD-B60 5.2 / 7.3、H.222.0)。 */
function validSectionCRC(section: Uint8Array): boolean {
    if (section.length < 3) { return false; }
    const length = ((section[1] & 0x0F) << 8) | section[2];
    return length >= 4 && length + 3 <= section.length && calculateCRC32(section.subarray(0, length + 3), -1) === 0;
}

/** 先頭sectionのみを読む依存parserに、CRCの保護範囲より後のsection/paddingを読ませない。 */
function tlvSectionEnd(packet: Uint8Array): number {
    const tableId = packet[4];
    if (packet.length < 7 || (tableId !== 0x40 && tableId !== 0x41 && tableId !== 0xFE)) { return packet.length; }
    return Math.min(packet.length, 7 + ((packet[5] & 0x0F) << 8) + packet[6]);
}

/** 再組立済みM2 sectionだけを検証する。PA/MPT/PLTやCRCのないMH-DITには適用しない。 */
function validM2SectionCRC(parts: Uint8Array[]): boolean {
    const header = new Uint8Array(8);
    let bytes = 0;
    for (const part of parts) {
        if (bytes < header.length) { header.set(part.subarray(0, header.length - bytes), bytes); }
        bytes += part.length;
    }
    if (bytes < 2 || header[0] !== 0x80 || (header[1] !== 0 && header[1] !== 2)) { return true; }
    // M2 short sectionはreaderが解析するMH-TOTを検証し、CRCのないMH-DIT等には適用しない。
    if (header[1] === 2 && (bytes < 6 || header[5] !== 0xA1)) { return true; }
    if (bytes < header.length) { return false; }
    const messageLength = (header[3] << 8) | header[4];
    const sectionLength = ((header[6] & 0x0F) << 8) | header[7];
    if (sectionLength < 4 || messageLength < sectionLength + 3 || bytes < messageLength + 5) { return false; }
    // 映像チャンク全体や再組立済みメッセージをコピーせず、断片の境界をまたいでCRCを継続する。
    let offset = 0;
    let crc = -1;
    const end = 5 + 3 + sectionLength;
    for (const part of parts) {
        const start = Math.max(0, 5 - offset);
        const stop = Math.min(part.length, end - offset);
        if (stop > start) { crc = calculateCRC32(part.subarray(start, stop), crc); }
        offset += part.length;
        if (offset >= end) { break; }
    }
    return crc === 0;
}

/**
 * TLV (MMT) version of TSFilter.
 * The output is the whole TLV stream for the channel,
 * and the one of the service only for the service (see TLVServiceSelector).
 */
export default class TLVFilter extends EventEmitter {

    streamInfo: StreamInfo = {};

    private _reader: MMTTLVReader = createMMTTLVReader();
    private _selector: TLVServiceSelector = null;
    private _tsmf: TSMFTLV = null;
    private _bonding: TSMFBonding = null;

    // output
    private _output: Writable;
    private readonly _handleOutputClose: () => void;
    private readonly _handleOutputDrain: () => void;
    // 書き出せない間に保持する出力 (上限を超えた分は古いものから破棄する)
    private _buffer: Buffer[] = [];
    private _bufferBytes = 0;
    private _bufferRetainedCount = 0;
    private _maxBufferBytes: number = _.config.server.maxBufferBytesBeforeReady || 1024 * 1024 * 8;

    // options
    private _provideServiceId: number;
    private _provideEventId: number;
    private _parseNIT = false;
    private _parseSDT = false;
    private _parseEIT = false;
    private _targetNetworkId: number;

    // epg
    private _epg: MHEPG;
    private _epgKey: string = null;
    private _epgNetworkId: number = null;
    private _epgReady = false;
    private _epgState = new EPGState();

    // state
    private _closed = false;
    private _ready = true;
    private _serviceIds = new Set<number>();
    private _provideServiceFound = false;
    private _streamTime: number = null;
    private _provideEventLastDetectedAt = -1;
    private _provideEventTimeout: NodeJS.Timeout = null;
    private _eventEndTimeout = _.config.server.eventEndTimeout || 1000;

    // the remainder of the last chunk to count the TLV packets
    private _countBuffer: Buffer = null;
    private _countStorage: Buffer | null = null;
    private _readerBuffer: Buffer = null;
    private _readerStorage: Buffer = null;
    private _readerBytes = 0;
    private _readerSynced = false;
    private _countBytes = 0;
    private readonly _rejectedPackets = new Set<number>();
    private _parseErrorReported = false;
    private _siParseErrorReported = false;
    private _crcErrorReported = false;
    // the input continues from a TLV packet found (the output starts at the head of a TLV packet)
    private _packetSynced = false;

    private _remoteControlKeyIdMap: Map<number, number> = null;
    private _logoBytes = 0;
    private _logoLimitReported = false;
    private _logoTransmissions: Map<number, {
        startSectionNumber: number;
        numberOfSections: number;
        logoVersion: number;
        receivedSections: number;
        bytes: number;
        data: Uint8Array[];
    }> = new Map();

    constructor(options: TLVFilterOptions) {
        super();
        this._handleOutputClose = () => this._close();
        this._handleOutputDrain = () => this.flush();

        this._targetNetworkId = options.networkId || null;
        this._provideServiceId = options.serviceId || null;
        this._provideEventId = options.eventId || null;

        if (options.tsmfRelTs && options.tsmfCarriers > 1) {
            this._bonding = new TSMFBonding(options.tsmfRelTs, options.tsmfCarriers, reason => {
                log.error("TLVFilter: ❌ 搬送波を結合できないため配信を終了します (%s)", reason);
                this._close();
            });
        } else if (options.tsmfRelTs) {
            this._tsmf = new TSMFTLV(options.tsmfRelTs);
        }

        if (this._provideServiceId !== null) {
            this._ready = false;
        }
        // 出力のない解析専用フィルターには、番組終了を監視するタイマーを作らない。
        if (this._provideEventId !== null && options.output) {
            this._ready = false;

            const program = _.program.get(getProgramItemId(this._targetNetworkId, this._provideServiceId, this._provideEventId));
            if (program) {
                let timeout = program.startAt + program.duration - Date.now();
                if (program.duration === 1) {
                    timeout += 1000 * 60 * 3;
                }
                if (timeout < 0) {
                    timeout = 1000 * 60 * 3;
                }
                this._provideEventTimeout = setTimeout(() => this._observeProvideEvent(), timeout);
            }
        }
        if (options.output) {
            this._output = options.output;
            this._output.once("finish", this._handleOutputClose);
            this._output.once("close", this._handleOutputClose);
            this._output.on("drain", this._handleOutputDrain);
        } else {
            this._provideServiceId = null;
            this._provideEventId = null;
            this._ready = false;
        }
        if (this._provideServiceId !== null) {
            this._selector = new TLVServiceSelector(this._provideServiceId);
        }
        // TSMF から取り出した TLV は、TLV パケットの単位で届く
        this._packetSynced = this._tsmf !== null || this._bonding !== null;
        this._readerSynced = this._packetSynced;
        if (options.parseNIT === true) {
            this._parseNIT = true;
        }
        if (options.parseSDT === true) {
            this._parseSDT = true;
        }
        if (options.parseEIT === true) {
            this._parseEIT = true;
        }

        // 依存2.0.2のMMTPReader.onSIは断片の結合後・readMessages前の公開メソッド。
        // 外側readerに公開の検証口がないため、このインスタンスの結合済み入力だけを補完する。
        // prototypeや依存ファイルは変更せず、継続番号・IP context・MPTを元のreaderに任せる。
        const mmtp = (this._reader as unknown as { mmtpReader: MMTPReader }).mmtpReader;
        const readSI = mmtp.onSI.bind(mmtp);
        mmtp.onSI = (packetId, parts) => {
            if (this._closed) { return; }
            if (!validM2SectionCRC(parts)) {
                mmtp.siPacketQueue.delete(packetId);
                const asset = mmtp.assets.get(packetId);
                if (asset) { ++asset.dropPacketCount; }
                this._reportCRCFailure();
                // 既に前のTLVへ出力した断片は戻せないため、MH-SIの解析だけを破棄する。
                return;
            }
            readSI(packetId, parts);
        };

        // 同じpush内でcloseした後もreaderが後続通知を送る場合があるため、通知入口で止める。
        const onTable = <T>(listener: (table: T) => void) => (e: { table: T }) => {
            if (!this._closed) { listener(e.table); }
        };
        this._reader.addEventListener("plt", onTable<PackageListTable>(table => this._onPLT(table)));
        this._reader.addEventListener("mpt", onTable<MMTPackageTable>(table => this._onMPT(table)));
        if (this._parseNIT) {
            this._reader.addEventListener("nit", onTable<TLVNetworkInformationTable>(table => this._onNIT(table)));
        }
        if (this._parseSDT || this._parseEIT) {
            // SDTのロゴ情報はサービス走査とEPG取得の両方で利用する。
            this._reader.addEventListener("sdt", onTable<MHServiceDescriptionTable>(table => this._onSDT(table)));
            this._reader.addEventListener("cdt", onTable<MHCommonDataTable>(table => this._onCDT(table)));
        }
        // 通常の視聴ではMH-EITの解析を省く。番組指定はparseEITなしでもp/fを必要とする。
        if (this._parseEIT || this._provideEventId !== null) {
            this._reader.addEventListener("eit", onTable<MHEventInformationTable>(table => this._onEIT(table)));
        }
        if (this._parseEIT) {
            this._reader.addEventListener("tot", onTable<MHTimeOffsetTable>(table => this._onTOT(table)));
        }

        this.once("end", this._close.bind(this));
        this.once("close", this._close.bind(this));

        log.info("TLVFilter: created (serviceId=%d, eventId=%d)", this._provideServiceId, this._provideEventId);

        if (this._ready === false) {
            log.info("TLVFilter: waiting for serviceId=%d, eventId=%d", this._provideServiceId, this._provideEventId);
        }

        // counted as TSFilter for the status (the filters of streams)
        ++status.streamCount.tsFilter;
    }

    get closed(): boolean {
        return this._closed;
    }

    /**
     * @param defer `true` to hold the output until `flush()`
     */
    write(chunk: Buffer, defer = false): void {
        if (this._closed) {
            throw new Error("TLVFilter has closed already");
        }

        if (this._bonding) {
            this._writeTLV(this._bonding.push(0, chunk), defer);
        } else if (this._tsmf) {
            this._writeTLV(this._tsmf.push(chunk), defer);
        } else {
            this._writeTLV(chunk, defer);
        }
    }

    /**
     * the input from the other carriers (`tsmfCarriers`)
     * @param carrier 1..tsmfCarriers - 1
     */
    writeCarrier(carrier: number, chunk: Buffer, defer = false): void {
        // (the carriers are not bonded without `tsmfRelTs`)
        if (this._closed || this._bonding === null) {
            return;
        }
        this._writeTLV(this._bonding.push(carrier, chunk), defer);
    }

    /** 保留している出力を書き出す (書き出せない間は保持し、上限を超えた分を古いものから破棄する) */
    flush(): void {
        if (this._closed || this._buffer.length === 0) {
            return;
        }

        if (this._ready && this._output.writableLength < this._output.writableHighWaterMark) {
            const buffer = this._buffer;
            const output = this._output;
            this._buffer = [];
            this._bufferBytes = 0;
            this._bufferRetainedCount = 0;
            // 端数から完成したパケットと入力内の連続区間を、再連結せずまとめて書き出す。
            output.cork();
            try { for (const data of buffer) { output.write(data); } } finally { output.uncork(); }
            return;
        }

        // 準備前の先行分は通常の上限処理として破棄し、出力詰まりによる破棄だけを数える。
        if (this._ready && this._bufferBytes > this._maxBufferBytes) {
            ++status.errorCount.bufferOverflow;
        }
        // 出力するチャンクは TLV パケットの単位のため、TLV パケットの途中で途切れないようチャンクの単位で破棄する
        this._bufferBytes = retainOutput(this._buffer, this._bufferRetainedCount,
            this._bufferBytes, this._maxBufferBytes, true);
        this._bufferRetainedCount = this._buffer.length;
    }

    end(): void {
        this._close();
    }

    close(endOutput = true): void {
        this._close(endOutput);
    }

    private _writeTLV(chunk: Buffer, defer: boolean): void {
        if (chunk.length === 0 || this._closed) {
            return;
        }

        // 出力は TLV パケットの単位 (書き出せずに破棄しても、TLV パケットの途中で途切れない)
        const selected: Buffer[] | undefined = this._selector ? [] : undefined;
        this._readPackets(chunk, selected);
        if (this._closed) { return; }
        const packets = this._output ? this._countPackets(chunk) : [];

        // 番組指定では切り替えの通知が遅れても先頭を失わないよう、選択済みの入力を上限まで保持する。
        // TS経路と同じく準備前の先行分を含み、厳密な番組境界での切り出しは保証しない。
        if (this._output && (this._ready || this._provideEventId !== null)) {
            for (const packet of selected ?? packets) {
                this._buffer.push(packet);
                this._bufferBytes += packet.length;
            }
            if (defer === false) { this.flush(); }
        }
    }

    /** 解析不能なSIを除き、サービス指定時はパケット順、それ以外はまとめてreaderへ渡す。 */
    private _readPackets(chunk: Buffer, selected?: Buffer[]): void {
        let offset = 0;
        while (this._readerBuffer && offset < chunk.length && !this._closed) {
            const held = this._readerBuffer;
            // 保留パケットを完成させる分だけ連結し、chunk後半の完全なパケット列はコピーしない。
            // 未同期の候補は次の同期バイトまで待つ必要があるため1バイトだけ余分に読む。
            const required = held.length < 4 ? 4 : 4 + held.readUInt16BE(2) + (!this._readerSynced ? 1 : 0);
            const length = Math.min(chunk.length - offset, Math.max(1, required - held.length));
            this._readPacketBlock(chunk.subarray(offset, offset + length), selected);
            offset += length;
        }
        if (offset < chunk.length && !this._closed) { this._readPacketBlock(chunk.subarray(offset), selected); }
    }

    private _readPacketBlock(chunk: Buffer, selected?: Buffer[]): void {
        // readerはIPv4を省き、出力は保持するため、消費位置と端数は分離して管理する。
        const held = this._readerBuffer;
        const base = this._readerBytes - (held?.length ?? 0);
        let data = chunk;
        if (held) {
            const length = held.length + chunk.length;
            let storage = this._readerStorage;
            let start = storage && held.buffer === storage.buffer ? held.byteOffset - storage.byteOffset : -1;
            // 未完了の候補が少しずつずれても既存部分はコピーし直さず、空き領域へ追記する。
            // 最大パケット+同期1byteの2倍までとし、領域が尽きた場合だけ保留を新しい領域へ移す。
            // readerが渡したviewを保持し得るため、消費済みの先頭へ上書きして詰め直さない。
            if (!storage || start < 0 || start + length > storage.length) {
                storage = Buffer.allocUnsafe(Math.min(2 * 65540, Math.max(16, length * 2)));
                held.copy(storage);
                start = 0;
                this._readerStorage = storage;
            }
            chunk.copy(storage, start + held.length);
            data = storage.subarray(start, start + length);
        }
        this._readerBytes += chunk.length;
        this._readerBuffer = null;
        const passed: Buffer[] = [];
        let synced = this._readerSynced;
        let passStart = 0;
        let pos = 0;
        while (pos < data.length) {
            const start = data.indexOf(0x7F, pos);
            if (start < 0) {
                if (synced && pos > passStart) { passed.push(data.subarray(passStart, pos)); }
                passStart = data.length;
                synced = false;
                pos = data.length;
                break;
            }
            if (start !== pos) {
                if (synced && pos > passStart) { passed.push(data.subarray(passStart, pos)); }
                // 依存readerは次の同期位置を検証しないため、未確認の候補や同期外のバイトは渡さない。
                passStart = start;
                synced = false;
            }
            if (start + 4 > data.length) { pos = start; break; }
            const type = data[start + 1];
            if (type !== 0x01 && type !== 0x02 && type !== 0x03 && type !== 0xFE && type !== 0xFF) {
                if (synced && start > passStart) { passed.push(data.subarray(passStart, start)); }
                synced = false;
                pos = start + (type === 0x7F ? 1 : 2);
                passStart = pos;
                continue;
            }
            const end = start + 4 + data.readUInt16BE(start + 2);
            if (end > data.length) { pos = start; break; }
            if (!synced) {
                // 型に関係なく、未同期の候補は末尾の次の同期バイトで境界を確認する。
                // 出力側と同じく宣言末尾の次の同期バイトを待ち、境界不一致が判明した候補だけを再走査する。
                if (end === data.length) { pos = start; break; }
                if (data[end] !== 0x7F) { pos = start + 2; passStart = pos; continue; }
            }
            synced = true;
            let parseFailure: { error: unknown } | undefined;
            const packet = data.subarray(start, end);
            const sectionEnd = type === 0xFE ? tlvSectionEnd(packet) : packet.length;
            const tableId = data[start + 4];
            const invalidCRC = type === 0xFE && (tableId === 0x40 || tableId === 0x41 || tableId === 0xFE)
                && !validSectionCRC(data.subarray(start + 4, end));
            if (type === 0xFE && end > start + 4 && !invalidCRC) {
                // SIのpure parserだけを事前実行する。readerを進めず、既存contextや同chunk後半を残す。
                // SIは低頻度の制御情報であり、映像のMMTP/IPv4は二重解析しない。
                try { readTLVSI(packet.subarray(0, sectionEnd)); } catch (error) { parseFailure = { error }; }
            }
            // 依存readerはIPv4未対応でpayloadもTLVとして走査するため、解析入力からはパケット全体を省く。
            // 出力とサービス選択には、解析用入力から省いたIPv4パケットもそのまま渡す。
            if (type === 0x01) {
                if (start > passStart) { passed.push(data.subarray(passStart, start)); }
                passStart = end;
            } else if (type === 0xFE && (end === start + 4 || parseFailure || invalidCRC)) {
                // 解析不能またはCRC不一致のSIを、出力側も同じ絶対位置で除外する。
                if (start > passStart) { passed.push(data.subarray(passStart, start)); }
                passStart = end;
                if (this._output) { this._rejectedPackets.add(base + start); }
                if (invalidCRC) {
                    this._reportCRCFailure();
                } else if (parseFailure) {
                    if (!this._siParseErrorReported) {
                        this._siParseErrorReported = true;
                        const error = parseFailure.error;
                        log.warn("TLVFilter: ⚠️ TLV制御パケットを解析できないため、このパケットを破棄して受信を継続します (%s)", error instanceof Error ? error.message : String(error));
                    }
                } else if (!this._parseErrorReported) {
                    this._parseErrorReported = true;
                    log.warn("TLVFilter: ⚠️ tableIdのない空のTLV制御パケットを破棄し、受信を継続します。");
                }
            } else if (sectionEnd < packet.length) {
                // 既存parserが読む第一sectionだけを切り出し、CRC範囲外のsection/paddingを読ませない。
                // 余剰があるSIだけ解析用コピーのTLV長を直し、出力側は元のパケットを保持する。
                if (start > passStart) { passed.push(data.subarray(passStart, start)); }
                const bounded = Buffer.from(packet.subarray(0, sectionEnd));
                bounded.writeUInt16BE(bounded.length - 4, 2);
                passed.push(bounded);
                passStart = end;
            }
            if (selected) {
                // PLT/MPTの更新より前のパケットへ、新しい選択状態を遡って適用しない。
                // サービス指定時だけ解析と選択をパケット順に進め、未指定時の一括解析は維持する。
                // reader内のコピーは許容し、同じchunk内の表更新を過去のメディアへ適用しないことを優先する。
                if (end > passStart) { passed.push(data.subarray(passStart, end)); }
                this._pushReader(passed);
                passed.length = 0;
                passStart = end;
                if (this._closed) { return; }
                if (!this._rejectedPackets.has(base + start)) {
                    const output = this._selector!.push(packet);
                    // 番組指定だけ対象MPT後の先行分を保留する。サービス指定のみでは、
                    // このパケットの解析時点で準備が完了するまで出力へ積まない。
                    if (output.length > 0 && (this._ready || (this._provideEventId !== null && this._selector!.ready))) {
                        // 解析・選択はパケット順を保ち、入力の連続区間だけコピーせず1回の出力へまとめる。
                        const previous = selected[selected.length - 1];
                        if (previous && previous.buffer === output.buffer && previous.byteOffset + previous.length === output.byteOffset) {
                            selected[selected.length - 1] = Buffer.from(previous.buffer, previous.byteOffset, previous.length + output.length);
                        } else {
                            selected.push(output);
                        }
                    }
                }
            }
            pos = end;
        }
        // 長さフィールドは16bitのため、次の同期を待つ候補も最大65539バイトで収まる。
        // 外部chunkの端数だけを所有し、大きい入力を小さなviewで保持し続けない。
        // listenerからcloseされる場合に備え、受信通知より先に保留を更新する。
        this._readerSynced = synced;
        if (pos < data.length) {
            if (held) {
                this._readerBuffer = data.subarray(pos);
            } else {
                const rest = data.subarray(pos);
                const storage = Buffer.allocUnsafe(Math.min(2 * 65540, Math.max(16, rest.length * 2)));
                rest.copy(storage);
                this._readerStorage = storage;
                this._readerBuffer = storage.subarray(0, rest.length);
            }
        } else {
            this._readerStorage = null;
        }
        if (pos > passStart) { passed.push(data.subarray(passStart, pos)); }
        this._pushReader(passed);
    }

    private _pushReader(passed: Buffer[]): void {
        if (passed.length > 0) {
            try { this._reader.push(passed.length === 1 ? passed[0] : Buffer.concat(passed)); } catch (error) {
                // 事前検証したSI以外のparser例外やlistener・保存処理の失敗は正常継続にしない。
                // 依存readerは例外時に未消費bufferを残すため、解放して当該filterだけを閉じる。
                this._reader.reset();
                log.error("TLVFilter#_readPackets: TLVの解析中にエラーが発生したため配信を終了します (%s)", error instanceof Error ? error.stack || error.message : String(error));
                this._close();
                // listenerや保存処理の原因も上で記録し、同じチューナーのほかの利用者へ例外を波及させない。
            }
        }
    }

    /**
     * counts the TLV packets
     * @returns the complete TLV packets of the input from the first one found (the rest is kept for the next input,
     * the bytes not continuing to a TLV packet are not output until the next one is found)
     */
    private _countPackets(chunk: Buffer): Buffer[] {
        const packets: Buffer[] = [];
        let offset = 0;
        while (this._countBuffer && offset < chunk.length) {
            const held = this._countBuffer;
            const required = held.length < 4 ? 4 : 4 + held.readUInt16BE(2) + (!this._packetSynced ? 1 : 0);
            const length = Math.min(chunk.length - offset, Math.max(1, required - held.length));
            this._countPacketBlock(chunk.subarray(offset, offset + length), packets);
            offset += length;
        }
        if (offset < chunk.length) { this._countPacketBlock(chunk.subarray(offset), packets); }
        return packets;
    }

    private _countPacketBlock(chunk: Buffer, packets: Buffer[]): void {
        const held = this._countBuffer;
        const base = this._countBytes - (held?.length ?? 0);
        let buf = chunk;
        if (held) {
            const length = held.length + chunk.length;
            let storage = this._countStorage;
            let start = storage && held.buffer === storage.buffer ? held.byteOffset - storage.byteOffset : -1;
            // 出力viewは送信待ちで保持され得るため、消費済みの領域へ詰め直さず空き領域へ追記する。
            if (!storage || start < 0 || start + length > storage.length) {
                storage = Buffer.allocUnsafe(Math.min(2 * 65540, Math.max(16, length * 2)));
                held.copy(storage);
                start = 0;
                this._countStorage = storage;
            }
            chunk.copy(storage, start + held.length);
            buf = storage.subarray(start, start + length);
        }
        this._countBytes += chunk.length;
        this._countBuffer = null;

        let synced = this._packetSynced;
        // the bytes before the first TLV packet are not output
        let start = synced ? 0 : -1;
        // the first TLV packet which may start, not known until the next input
        let pending = -1;
        // 出力する区間だけを集め、除去のたびに既出分をコピーし直さない。
        let pos = 0;
        while (pos + 4 <= buf.length) {
            if (buf[pos] !== 0x7F) {
                if (synced) {
                    synced = false;
                    if (pos > start) {
                        packets.push(buf.subarray(start, pos));
                    }
                    start = -1;
                }
                ++pos;
                continue;
            }
            const type = buf[pos + 1];
            if (type !== 0x01 && type !== 0x02 && type !== 0x03 && type !== 0xFE && type !== 0xFF) {
                // 解析側と同じ境界へ戻し、未定義種別の宣言長で未検証のSIを包んで出力しない。
                if (synced && pos > start) { packets.push(buf.subarray(start, pos)); }
                synced = false;
                start = -1;
                pos += type === 0x7F ? 1 : 2;
                continue;
            }
            const end = pos + 4 + buf.readUInt16BE(pos + 2);
            if (synced === false) {
                // starts at the TLV packet (of the packet type defined: IPv4, IPv6, compressed IP, signalling, null) followed by another one
                // 未同期の候補の内部を先に出力しない。reader側のCRC検証と同じ境界まで待つ。
                if (end >= buf.length) {
                    if (pending === -1) { pending = pos; }
                    break;
                }
                if (buf[end] !== 0x7F) {
                    ++pos;
                    continue;
                }
                synced = true;
                pending = -1;
                if (start === -1) {
                    start = pos;
                }
            } else if (end > buf.length) {
                break;
            }
            const info = this.streamInfo[buf[pos + 1]] || (this.streamInfo[buf[pos + 1]] = { packet: 0, drop: 0 });
            ++info.packet;
            if (this._rejectedPackets.delete(base + pos)) {
                ++info.drop;
                if (pos > start && start !== -1) {
                    packets.push(buf.subarray(start, pos));
                }
                start = end;
            }
            pos = end;
        }
        this._packetSynced = synced;
        let rest = pending === -1 ? pos : pending;
        if (!synced && pending === -1) {
            // ヘッダーになり得ない端数は保持せず、次回の入力を1byteずつ組み直さない。
            while (rest < buf.length) {
                const marker = buf.indexOf(0x7F, rest);
                if (marker === -1) { rest = buf.length; break; }
                const type = buf[marker + 1];
                if (type === undefined || type === 0x01 || type === 0x02 || type === 0x03 || type === 0xFE || type === 0xFF) {
                    rest = marker;
                    break;
                }
                rest = marker + 1;
            }
        }
        // 出力側が消費した領域の拒否位置は残さず、次回に保留した領域だけを保持する。
        for (const rejected of this._rejectedPackets) { if (rejected < base + rest) { this._rejectedPackets.delete(rejected); } }
        if (rest < buf.length) {
            if (held) {
                this._countBuffer = buf.subarray(rest);
            } else {
                const tail = buf.subarray(rest);
                const storage = Buffer.allocUnsafe(Math.min(2 * 65540, Math.max(16, tail.length * 2)));
                tail.copy(storage);
                this._countStorage = storage;
                this._countBuffer = storage.subarray(0, tail.length);
            }
        } else {
            this._countStorage = null;
        }
        if (start !== -1 && rest > start) { packets.push(buf.subarray(start, rest)); }
    }

    private _reportCRCFailure(): void {
        if (this._crcErrorReported) { return; }
        this._crcErrorReported = true;
        log.warn("TLVFilter: CRCまたはセクション長が不正な制御情報を破棄し、受信を継続します。");
    }

    private _onPLT(plt: PackageListTable): void {
        const serviceIds = new Set<number>();
        for (const pkg of plt.packages) {
            serviceIds.add(mmtPackageIdToServiceId(pkg.mmtPackageId));
        }
        this._serviceIds = serviceIds;
        this._selector?.onPLT(plt);

        // 一度確認したサービスの番組監視は、一時的なPLT欠落で停止しない。
        // 最新PLTに基づくサービス一覧とメディア選択は、上で別途更新する。
        if (this._provideServiceId !== null && serviceIds.has(this._provideServiceId)) {
            this._provideServiceFound = true;
        }
    }

    private _onMPT(mpt: MMTPackageTable): void {
        this._selector?.onMPT(mpt);

        if (this._ready === false && this._provideServiceFound && this._provideEventId === null) {
            if (mmtPackageIdToServiceId(mpt.mmtPackageId) !== this._provideServiceId) {
                return;
            }
            this._ready = true;
            log.info("TLVFilter#_onMPT: now ready for serviceId=%d", this._provideServiceId);
        }
    }

    private _onNIT(nit: TLVNetworkInformationTable): void {
        if (this._parseNIT === false || this._remoteControlKeyIdMap !== null) {
            return;
        }
        if (nit.tableId !== "TLV-NIT[actual]") {
            return;
        }

        this._remoteControlKeyIdMap = new Map();
        for (const desc of nit.networkDescriptors) {
            if (desc.tag === "remoteControlKey") {
                for (const key of desc.keys) {
                    this._remoteControlKeyIdMap.set(key.serviceId, key.remoteControlKeyId);
                }
            }
        }

        this.emit("network", {
            networkId: nit.networkId,
            areaCode: -1,
            remoteControlKeyId: -1
        });
    }

    private _onSDT(sdt: MHServiceDescriptionTable): void {
        // the logo transmission is only in MH-SDT, read it while gathering EPG too
        if (this._parseSDT === false && this._parseEIT === false) {
            return;
        }
        if (sdt.tableId !== "SDT[actual]") {
            return;
        }
        // wait for PLT and TLV-NIT not to lack the services and the remote control keys
        if (this._serviceIds.size === 0 || (this._parseNIT && this._remoteControlKeyIdMap === null)) {
            return;
        }

        const _services = [];

        for (const service of sdt.services) {
            if (this._serviceIds.has(service.serviceId) === false) {
                continue;
            }

            let name = "";
            let type = -1;
            let logoId = -1;

            for (const desc of service.descriptors) {
                if (desc.tag === "mhServiceDescriptor") {
                    name = decodeUTF8(desc.serviceName);
                    type = desc.serviceType;
                }

                if (desc.tag === "mhLogoTransmission") {
                    logoId = desc.logoId;
                    if (desc.logoTransmissionType === MH_LOGO_TRANSMISSION_TYPE_DIRECT) {
                        const largeLogo = desc.logoList.find(x => x.logoType === MH_CDT_LOGO_TYPE_LARGE);
                        if (largeLogo !== undefined) {
                            const p = this._logoTransmissions.get(logoId);
                            if (p === undefined || p.logoVersion !== desc.logoVersion) {
                                if (!Number.isInteger(largeLogo.startSectionNumber) || largeLogo.startSectionNumber < 0 ||
                                    !Number.isInteger(largeLogo.numOfSections) || largeLogo.numOfSections <= 0 ||
                                    largeLogo.startSectionNumber + largeLogo.numOfSections > 256) { continue; }
                                if (p === undefined && this._logoTransmissions.size >= MAX_LOGO_DOWNLOADS) {
                                    this._warnLogoLimit();
                                    continue;
                                }
                                this._logoBytes -= p?.bytes ?? 0;
                                this._logoTransmissions.set(logoId, {
                                    startSectionNumber: largeLogo.startSectionNumber,
                                    numberOfSections: largeLogo.numOfSections,
                                    logoVersion: desc.logoVersion,
                                    receivedSections: 0,
                                    bytes: 0,
                                    data: []
                                });
                            }
                        }
                    }
                }
            }

            _services.push({
                networkId: sdt.originalNetworkId,
                serviceId: service.serviceId,
                streamId: sdt.tlvStreamId,
                isFree: !service.freeCAMode,
                name,
                type,
                logoId,
                remoteControlKeyId: this._remoteControlKeyIdMap?.get(service.serviceId)
            });
        }

        if (this._parseSDT) {
            this.emit("services", _services);
        }
    }

    private _onEIT(eit: MHEventInformationTable): void {
        // current_next=0は未適用の表なので、番組境界・EPG保存・取得完了の判定に使わない。
        if (!eit.currentNextIndicator) { return; }
        // detect current event
        if (
            this._provideServiceFound &&
            eit.events.length !== 0 &&
            this._provideEventId !== null && eit.tableId === "EIT[p/f]" && eit.sectionNumber === 0 &&
            this._provideServiceId === eit.serviceId
        ) {
            if (eit.events[0].eventId === this._provideEventId) {
                this._provideEventLastDetectedAt = Date.now();

                if (this._ready === false) {
                    this._ready = true;
                    log.info("TLVFilter#_onEIT: now ready for eventId=%d", this._provideEventId);
                }
            } else if (this._ready) {
                log.info("TLVFilter#_onEIT: closing because eventId=%d has ended...", this._provideEventId);

                const eventId = this._provideEventId;
                this._provideEventId = null;
                setTimeout(() => {
                    // 番組の終了までに出力すると決まっていた分は、保留していても書き出す
                    this.flush();
                    this._ready = false;
                    this._provideEventId = eventId;
                    this._close();
                }, this._eventEndTimeout);
            }
        }

        // 番組監視とサービス発見は登録前でも行い、EPG保存・取得完了の管理は登録済みのNID/SIDだけに限定する。
        if (this._parseEIT === false || this._serviceIds.has(eit.serviceId) === false ||
            !_.service.get(eit.originalNetworkId, eit.serviceId)) {
            return;
        }
        // EPG of a TLV stream is written by only one filter
        if (!this._epg) {
            const key = getEpgStreamKey(eit.originalNetworkId, eit.tlvStreamId);
            if (status.epgByStream[key] === true) {
                return;
            }
            status.epgByStream[key] = true;
            this._epgKey = key;
            this._epgNetworkId = eit.originalNetworkId;
            this._epg = new MHEPG();
        }

        this._epg.write(eit);

        if (this._epgReady === false && eit.tableId !== "EIT[p/f]") {
            const ready = this._epgState.update({
                networkId: eit.originalNetworkId,
                serviceId: eit.serviceId,
                versionNumber: eit.versionNumber,
                isBasic: eit.tableId === "EIT[schedule basic]",
                flagsId: eit.tableIndex & 0x07,
                // EPGStateはbasic/extended別の0〜7で管理する。readerのlastTableIndexも同じ区分内番号。
                // MH-EITの絶対table_idではなく、受信した区分内の最終位置を使う。
                lastFlagsId: eit.lastTableIndex & 0x07,
                sectionNumber: eit.sectionNumber,
                lastSectionNumber: eit.lastSectionNumber,
                segmentLastSectionNumber: eit.segmentLastSectionNumber
            }, this._streamTime);

            if (ready) {
                this._epgReady = true;
                this._epgState.clear();

                for (const service of this._ownServices()) {
                    service.epgReady = true;
                }

                process.nextTick(() => this.emit("epgReady"));
            }
        }
    }

    private _onTOT(tot: MHTimeOffsetTable): void {
        this._streamTime = mjdBCDToUnixEpoch(tot.jstTime) * 1000;
    }

    private _onCDT(cdt: MHCommonDataTable): void {
        if (cdt.dataType !== MH_CDT_DATA_TYPE_LOGO_DATA || cdt.dataModule.logoType !== MH_CDT_LOGO_TYPE_LARGE) {
            return;
        }

        const trans = this._logoTransmissions.get(cdt.dataModule.logoId);
        if (trans === undefined || cdt.dataModule.logoVersion !== trans.logoVersion || trans.receivedSections === trans.numberOfSections) {
            return;
        }
        if (cdt.sectionNumber < trans.startSectionNumber || cdt.sectionNumber >= trans.startSectionNumber + trans.numberOfSections) {
            return;
        }
        if (trans.data[cdt.sectionNumber - trans.startSectionNumber] !== undefined) {
            return;
        }

        const part = cdt.dataModule.data;
        if (this._logoBytes + part.byteLength > MAX_LOGO_DATA_BYTES) {
            this._warnLogoLimit();
            return;
        }
        // readerの大きな入力bufferをロゴの小さなviewだけで保持しない。
        trans.data[cdt.sectionNumber - trans.startSectionNumber] = Uint8Array.from(part);
        trans.bytes += part.byteLength;
        this._logoBytes += part.byteLength;
        trans.receivedSections += 1;
        if (trans.receivedSections !== trans.numberOfSections) {
            return;
        }
        const data = Buffer.concat(trans.data);
        this._logoBytes -= trans.bytes;
        trans.bytes = 0;
        trans.data = [];
        log.debug("TLVFilter#_onCDT: received logo data (networkId=%d, logoId=%d)", cdt.originalNetworkId, cdt.dataModule.logoId);
        void Service.saveLogoData(cdt.originalNetworkId, cdt.dataModule.logoId, data).catch(error => {
            log.warn("TLVFilter: ⚠️ ロゴデータを保存できませんでした (networkId=%d, logoId=%d, %s)", cdt.originalNetworkId, cdt.dataModule.logoId, error instanceof Error ? error.message : String(error));
        });
    }

    private _warnLogoLimit(): void {
        if (this._logoLimitReported) { return; }
        this._logoLimitReported = true;
        log.warn("TLVFilter: MH-CDTロゴの保持上限（16MiB・64件）に達したため、追加のロゴデータを保持せず受信を継続します。");
    }

    private _observeProvideEvent(): void {
        // note: EIT p/f interval is max 3s. (ARIB TR-B15)
        if (Date.now() - this._provideEventLastDetectedAt < 10000) {
            this._provideEventTimeout = setTimeout(() => this._observeProvideEvent(), 3000);
            return;
        }

        log.warn("TLVFilter#_observeProvideEvent: closing because EIT p/f timed out for eventId=%d...", this._provideEventId);
        this._close();
    }

    /** the services of the TLV stream (MH-EIT of a stream does not carry the other streams) */
    private _ownServices(): ServiceItem[] {
        return _.service.items.filter(service => this._serviceIds.has(service.serviceId) && service.networkId === this._epgNetworkId);
    }

    private _close(endOutput = true): void {
        if (this._closed) {
            return;
        }
        this._closed = true;

        clearTimeout(this._provideEventTimeout);

        this._reader.close();
        // close()だけでは入力・SI断片・contextを解放しないため、閉鎖filterからreaderへの参照も外す。
        delete this._reader;
        this._bonding?.close();
        this._countBuffer = null;
        this._countStorage = null;
        this._readerBuffer = null;
        this._readerStorage = null;
        this._readerSynced = false;
        this._rejectedPackets.clear();
        this._logoTransmissions.clear();
        this._logoBytes = 0;

        if (this._epg) {
            this._epg.end();
            delete this._epg;
            status.epgByStream[this._epgKey] = false;

            if (this._epgReady === true) {
                const now = Date.now();
                for (const service of this._ownServices()) {
                    service.epgUpdatedAt = now;
                }
            }
        }
        this._epgState.clear();

        if (this._output) {
            if (endOutput && this._output.writableEnded === false) {
                this._output.end();
            }
            this._output.removeListener("finish", this._handleOutputClose);
            this._output.removeListener("close", this._handleOutputClose);
            this._output.removeListener("drain", this._handleOutputDrain);
            delete this._output;
        }
        this._buffer = [];

        delete this.streamInfo;

        --status.streamCount.tsFilter;

        log.info("TLVFilter#_close: closed (serviceId=%s, eventId=%s)", this._provideServiceId, this._provideEventId);

        this.emit("close");
        this.emit("end");
    }
}
