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
import { TLVNetworkInformationTable } from "arib-mmt-tlv-ts/tlv-si.js";
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

/** the start of the TLV packet followed by another one, `-1` if not found */
function findTlvPacketStart(chunk: Buffer): number {
    for (let i = 0; i + 4 <= chunk.length; i++) {
        if (chunk[i] !== 0x7F) {
            continue;
        }
        const next = i + 4 + chunk.readUInt16BE(i + 2);
        if (next < chunk.length && chunk[next] === 0x7F) {
            return i;
        }
    }
    return -1;
}

const textDecoder = new TextDecoder();
function decodeUTF8(buffer: Uint8Array): string {
    return textDecoder.decode(buffer, { stream: false });
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
    // 書き出せない間に保持する出力 (上限を超えた分は古いものから破棄する)
    private _buffer: Buffer[] = [];
    private _bufferBytes = 0;
    private _bufferRetainedCount = 0;
    // 最初の出力は TLV パケットの先頭から始める
    private _outputStarted = false;
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

    private _remoteControlKeyIdMap: Map<number, number> = null;
    private _logoTransmissions: Map<number, {
        startSectionNumber: number;
        numberOfSections: number;
        logoVersion: number;
        receivedSections: number;
        data: Uint8Array[];
    }> = new Map();

    constructor(options: TLVFilterOptions) {
        super();

        this._targetNetworkId = options.networkId || null;
        this._provideServiceId = options.serviceId || null;
        this._provideEventId = options.eventId || null;

        if (options.tsmfRelTs && options.tsmfCarriers > 1) {
            this._bonding = new TSMFBonding(options.tsmfRelTs, options.tsmfCarriers, reason => {
                log.error("TLVFilter: closing because the bonded carriers can not be assembled (%s)", reason);
                this._close();
            });
        } else if (options.tsmfRelTs) {
            this._tsmf = new TSMFTLV(options.tsmfRelTs);
        }

        if (this._provideServiceId !== null) {
            this._ready = false;
        }
        if (this._provideEventId !== null) {
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
            this._output.once("finish", this._close.bind(this));
            this._output.once("close", this._close.bind(this));
            this._output.on("drain", () => this.flush());
        } else {
            this._provideServiceId = null;
            this._provideEventId = null;
            this._ready = false;
        }
        if (this._provideServiceId !== null) {
            this._selector = new TLVServiceSelector(this._provideServiceId);
        }
        if (options.parseNIT === true) {
            this._parseNIT = true;
        }
        if (options.parseSDT === true) {
            this._parseSDT = true;
        }
        if (options.parseEIT === true) {
            this._parseEIT = true;
        }

        this._reader.addEventListener("plt", e => this._onPLT(e.table));
        this._reader.addEventListener("mpt", e => this._onMPT(e.table));
        this._reader.addEventListener("nit", e => this._onNIT(e.table));
        this._reader.addEventListener("sdt", e => this._onSDT(e.table));
        this._reader.addEventListener("eit", e => this._onEIT(e.table));
        this._reader.addEventListener("tot", e => this._onTOT(e.table));
        this._reader.addEventListener("cdt", e => this._onCDT(e.table));

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
        if (this._closed) {
            return;
        }
        this._writeTLV(this._bonding.push(carrier, chunk), defer);
    }

    /** 保留している出力を書き出す (書き出せない間は保持し、上限を超えた分を古いものから破棄する) */
    flush(): void {
        if (this._closed || this._buffer.length === 0) {
            return;
        }

        if (this._output.writableLength < this._output.writableHighWaterMark) {
            const data = this._buffer.length === 1 ? this._buffer[0] : Buffer.concat(this._buffer, this._bufferBytes);
            this._buffer = [];
            this._bufferBytes = 0;
            this._bufferRetainedCount = 0;
            this._output.write(data);
            return;
        }

        if (this._bufferBytes > this._maxBufferBytes) {
            ++status.errorCount.bufferOverflow;
        }
        this._bufferBytes = retainOutput(this._buffer, this._bufferRetainedCount,
            this._bufferBytes, this._maxBufferBytes);
        this._bufferRetainedCount = this._buffer.length;
    }

    end(): void {
        this._close();
    }

    close(): void {
        this._close();
    }

    private _writeTLV(chunk: Buffer, defer: boolean): void {
        if (chunk.length === 0 || this._closed) {
            return;
        }

        if (this._output) {
            this._countPackets(chunk);
        }
        this._reader.push(chunk);

        if (this._ready && this._output) {
            if (this._selector) {
                chunk = this._selector.push(chunk);
                if (chunk.length === 0) {
                    return;
                }
            } else if (this._outputStarted === false) {
                const start = findTlvPacketStart(chunk);
                if (start === -1) {
                    return;
                }
                this._outputStarted = true;
                chunk = chunk.subarray(start);
            }
            this._buffer.push(chunk);
            this._bufferBytes += chunk.length;
            if (defer === false) {
                this.flush();
            }
        }
    }

    private _countPackets(chunk: Buffer): void {
        const buf = this._countBuffer ? Buffer.concat([this._countBuffer, chunk]) : chunk;
        this._countBuffer = null;

        let pos = 0;
        while (pos + 4 <= buf.length) {
            if (buf[pos] !== 0x7F) {
                ++pos;
                continue;
            }
            const end = pos + 4 + buf.readUInt16BE(pos + 2);
            if (end > buf.length) {
                break;
            }
            const info = this.streamInfo[buf[pos + 1]] || (this.streamInfo[buf[pos + 1]] = { packet: 0, drop: 0 });
            ++info.packet;
            pos = end;
        }
        if (pos < buf.length) {
            this._countBuffer = Buffer.from(buf.subarray(pos));
        }
    }

    private _onPLT(plt: PackageListTable): void {
        const serviceIds = new Set<number>();
        for (const pkg of plt.packages) {
            serviceIds.add(mmtPackageIdToServiceId(pkg.mmtPackageId));
        }
        this._serviceIds = serviceIds;
        this._selector?.onPLT(plt);

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
                                this._logoTransmissions.set(logoId, {
                                    startSectionNumber: largeLogo.startSectionNumber,
                                    numberOfSections: largeLogo.numOfSections,
                                    logoVersion: desc.logoVersion,
                                    receivedSections: 0,
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

        if (this._parseEIT === false || this._serviceIds.has(eit.serviceId) === false) {
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

        trans.data[cdt.sectionNumber - trans.startSectionNumber] = cdt.dataModule.data;
        trans.receivedSections += 1;
        if (trans.receivedSections !== trans.numberOfSections) {
            return;
        }
        const data = Buffer.concat(trans.data);
        trans.data = [];
        log.debug("TLVFilter#_onCDT: received logo data (networkId=%d, logoId=%d)", cdt.originalNetworkId, cdt.dataModule.logoId);
        Service.saveLogoData(cdt.originalNetworkId, cdt.dataModule.logoId, data);
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

    private _close(): void {
        if (this._closed) {
            return;
        }
        this._closed = true;

        clearTimeout(this._provideEventTimeout);

        this._reader.close();
        delete this._reader;
        this._bonding?.close();

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
            if (this._output.writableEnded === false) {
                this._output.end();
            }
            this._output.removeAllListeners();
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
