/*
   Copyright 2016 kanreisa

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
import * as stream from "stream";
import { TsStreamLite, TsCrc32, TsChar, TsLogo, tsDataModule } from "@chinachu/aribts";
import { StreamInfo, getTimeFromMJD } from "./common";
import * as log from "./log";
import EPG from "./EPG";
import status from "./status";
import _ from "./_";
import { getProgramItemId } from "./Program";
import Service from "./Service";
import ServiceItem from "./ServiceItem";

interface StreamOptions extends stream.TransformOptions {
    readonly networkId?: number;
    readonly serviceId?: number;
    readonly eventId?: number;
    readonly noProvide?: boolean;
    readonly parseNIT?: boolean;
    readonly parseSDT?: boolean;
    readonly parseEIT?: boolean;
    readonly tsmfRelTs?: number;
}

const PACKET_SIZE = 188;

const PROVIDE_PIDS = [
    0x0000, // PAT
    0x0001, // CAT
    0x0010, // NIT
    0x0011, // SDT
    0x0012, // EIT
    0x0013, // RST
    0x0014, // TDT
    0x0023, // SDTT
    0x0024, // BIT
    0x0028, // SDTT
    0x0029 // CDT
];

const DSMCC_BLOCK_SIZE = 4066; // ARIB TR-B15

const LOGO_DATA_NAME_BS = Buffer.from("LOGO-05"); // ARIB STD-B21, ARIB TR-B15
const LOGO_DATA_NAME_CS = Buffer.from("CS_LOGO-05"); // ARIB STD-B21, ARIB TR-B15

interface BasicExtState {
    basic: {
        flags: FlagState[];
        lastFlagsId: number;
    };
    extended: {
        flags: FlagState[];
        lastFlagsId: number;
    };
}

interface FlagState {
    flag: Buffer;
    ignore: Buffer;
    version_number: number;
}

interface DownloadData {
    downloadId: number;
    // blockSize: number; // 4066
    moduleId: number;
    moduleVersion: number;
    moduleSize: number;
    loadedBytes: number;
    data?: Buffer;
}

export default class TSFilter extends stream.Transform {

    streamInfo: StreamInfo = {};

    // options
    private _provideServiceId: number;
    private _provideEventId: number;
    private _parseNIT: boolean = false;
    private _parseSDT: boolean = false;
    private _parseEIT: boolean = false;
    private _targetNetworkId: number;
    private _enableParseCDT: boolean = false;
    private _enableParseDSMCC: boolean = false;

    // tsmf
    private _tsmfEnableTsmfSplit: boolean = false;
    private _tsmfSlotCounter: number = -1;
    private _tsmfRelativeStreamNumber: number[] = [];
    private _tsmfTsNumber: number = 0;

    // aribts
    private _parser = new TsStreamLite();

    // epg
    private _epg: EPG;

    // buffer
    private _packet: Buffer = Buffer.alloc(PACKET_SIZE);
    private _offset: number = -1;
    private _buffer: Buffer[] = [];
    private _parses: Buffer[] = [];
    private _patsec: Buffer = Buffer.alloc(PACKET_SIZE - 4 - 1); // TS header, pointer_field

    // state
    private _closed: boolean = false;
    private _ready: boolean = true;
    private _providePids: Set<number> = null; // `null` to provides all
    private _parsePids: Set<number> = new Set();
    private _tsid: number = -1;
    private _patCRC: Buffer = Buffer.alloc(4);
    private _serviceIds: Set<number> = new Set();
    private _parseServiceIds: Set<number> = new Set();
    private _pmtPid: number = -1;
    private _pmtTimer: NodeJS.Timer;
    private _streamTime: number = null;
    private _essMap: Map<number, number> = new Map(); // <serviceId, pid>
    private _essEsPids: Set<number> = new Set();
    private _dlDataMap: Map<number, DownloadData> = new Map();
    private _logoDataTimer: NodeJS.Timer;
    private _epgReady: boolean = false;
    private _epgState: { [networkId: number]: { [serviceId: number]: BasicExtState } } = {};
    private _provideEventLastDetectedAt: number = -1;
    private _provideEventTimeout: NodeJS.Timer = null;

    /** Number divisible by a multiple of 188 */
    private _maxBufferBytesBeforeReady: number = (() => {
        let bytes = _.config.server.maxBufferBytesBeforeReady || 1024 * 1024 * 8;
        bytes = bytes - bytes % PACKET_SIZE;
        return bytes;
    })();
    private _eventEndTimeout: number = _.config.server.eventEndTimeout || 1000;

    constructor(options: StreamOptions) {
        super({
            allowHalfOpen: false,
            highWaterMark: _.config.server.highWaterMark || 1024 * 1024 * 24 // 24 MB
        });

        const enabletsmf = options.tsmfRelTs || 0;
        if (enabletsmf !== 0) {
                this._tsmfEnableTsmfSplit = true;
                this._tsmfTsNumber = options.tsmfRelTs;
        }

        this._targetNetworkId = options.networkId || null;
        this._provideServiceId = options.serviceId || null;
        this._provideEventId = options.eventId || null;

        if (this._provideServiceId !== null) {
            this._providePids = new Set(PROVIDE_PIDS);
            this._ready = false;
        }
        if (this._provideEventId !== null) {
            this._ready = false;

            const program = _.program.get(
                getProgramItemId(
                    this._targetNetworkId,
                    this._provideServiceId,
                    this._provideEventId
                )
            );
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
        if (options.noProvide === true) {
            this._provideServiceId = null;
            this._provideEventId = null;
            this._providePids = new Set();
            this._ready = false;
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

        if (this._targetNetworkId) {
            if (this._targetNetworkId === 4) { // ARIB TR-B15 (BS/CS)
                this._enableParseDSMCC = true;
            } else {
                this._enableParseCDT = true;
            }
        }

        this._parser.on("pat", this._onPAT.bind(this));
        this._parser.on("pmt", this._onPMT.bind(this));
        this._parser.on("nit", this._onNIT.bind(this));
        this._parser.on("sdt", this._onSDT.bind(this));
        this._parser.on("eit", this._onEIT.bind(this));
        this._parser.on("tot", this._onTOT.bind(this));

        this.once("end", this._close.bind(this));
        this.once("finish", this._close.bind(this));
        this.once("close", this._close.bind(this));

        log.info("TSFilter: created (serviceId=%d, eventId=%d)", this._provideServiceId, this._provideEventId);

        if (this._ready === false) {
            log.info("TSFilter: waiting for serviceId=%d, eventId=%d", this._provideServiceId, this._provideEventId);
        }

        ++status.streamCount.tsFilter;
    }

    _transform(chunk: Buffer, encoding: string, callback: Function) {

        if (this._closed) {
            callback(new Error("TSFilter has closed already"));
            return;
        }

        let offset = 0;
        const length = chunk.length;

        if (this._offset > 0) {
            if (length >= PACKET_SIZE - this._offset) {
                offset = PACKET_SIZE - this._offset;
                chunk.copy(this._packet, this._offset, 0, offset);
                this._processPacket(this._packet);
                this._offset = 0;
            } else {
                chunk.copy(this._packet, this._offset);
                this._offset += length;

                // chunk drained
                callback();
                return;
            }
        } else {
            for (; offset < length; offset++) {
                // sync byte (0x47) searching
                if (chunk[offset] === 71) {
                    this._offset = 0;
                    break;
                }
            }
        }

        for (; offset < length; offset += PACKET_SIZE) {
            // sync byte (0x47) verifying
            if (chunk[offset] !== 71) {
                offset -= PACKET_SIZE - 1;
                continue;
            }

            if (length - offset >= PACKET_SIZE) {
                this._processPacket(chunk.slice(offset, offset + PACKET_SIZE));
                this._offset = 0;
            } else {
                chunk.copy(this._packet, 0, offset);
                this._offset = length - offset;
            }
        }

        if (this._buffer.length !== 0) {
            if (this._ready) {
                this.push(Buffer.concat(this._buffer.splice(0, 16732))); // { let bytes = 1024 * 1024 * 3; (bytes - bytes % 188) / 188; }
            } else {
                const head = this._buffer.length - (this._maxBufferBytesBeforeReady / PACKET_SIZE);
                if (head > 0) {
                    this._buffer.splice(0, head);
                }
            }
        }

        if (this._parses.length !== 0) {
            this._parser.write(Buffer.concat(this._parses));
            this._parses = [];
        }

        callback();
    }

    private _processPacket(packet: Buffer): void {

        const pid = packet.readUInt16BE(1) & 0x1FFF;

        // tsmf
        if (this._tsmfEnableTsmfSplit) {
            if (pid === 0x002F) {
                const tsmfFlameSync = packet.readUInt16BE(4) & 0x1FFF;
                if (tsmfFlameSync !== 0x1A86 && tsmfFlameSync !== 0x0579) {
                    return;
                }

                this._tsmfRelativeStreamNumber = [];
                for (let i = 0; i < 26; i++) {
                    this._tsmfRelativeStreamNumber.push((packet[73 + i] & 0xf0) >> 4);
                    this._tsmfRelativeStreamNumber.push(packet[73 + i] & 0x0f);
                }

                this._tsmfSlotCounter = 0;
                return;
            }

            if (this._tsmfSlotCounter < 0 || this._tsmfSlotCounter > 51) {
                return;
            }

            this._tsmfSlotCounter++;

            if (this._tsmfRelativeStreamNumber[this._tsmfSlotCounter - 1] !== this._tsmfTsNumber) {
                return;
            }
        }

        // NULL
        if (pid === 0x1FFF) {
            return;
        }

        // transport_error_indicator
        if ((packet[1] & 0x80) >> 7 === 1) {
            if (this.streamInfo[pid]) {
                ++this.streamInfo[pid].drop;
            }
            return;
        }

        packet = Buffer.from(packet);

        // parse
        if (pid === 0) {
            const targetStart = packet[7] + 4;
            if (targetStart + 4 > 188) {
                // out of range. this packet is broken.
                if (this.streamInfo[pid]) {
                    ++this.streamInfo[pid].drop;
                }
                return; // drop
            }
            if (this._patCRC.compare(packet, targetStart, targetStart + 4) !== 0) {
                packet.copy(this._patCRC, 0, targetStart, targetStart + 4);
                this._parses.push(packet);
            }
        } else if (
            (pid === 0x12 && (this._parseEIT || this._provideEventId !== null)) ||
            pid === 0x14 ||
            this._parsePids.has(pid)
        ) {
            this._parses.push(packet);
        }

        if (this._ready === false && (pid === 0x12 || this._provideEventId === null)) {
            return;
        }
        if (this._providePids !== null && this._providePids.has(pid) === false) {
            return;
        }

        // PAT (0) rewriting
        if (pid === 0 && this._pmtPid !== -1) {
            this._patsec.copy(packet, 5, 0);
        }

        // packet counter
        if (!this.streamInfo[pid]) {
            this.streamInfo[pid] = {
                packet: 0,
                drop: 0
            };
        }
        ++this.streamInfo[pid].packet;

        this._buffer.push(packet);
    }

    private _onPAT(pid: number, data: any): void {

        this._tsid = data.transport_stream_id;
        this._serviceIds = new Set();
        this._parseServiceIds = new Set();

        for (const program of data.programs) {
            const serviceId = program.program_number as number;

            if (serviceId === 0) {
                const NIT_PID = program.network_PID;

                log.debug("TSFilter#_onPAT: detected NIT PID=%d", NIT_PID);

                if (this._parseNIT) {
                    this._parsePids.add(NIT_PID);
                }
                continue;
            }

            // detect ESS PMT PID
            if (
                // for future use
                // (this._targetNetworkId !== 4 && serviceId >= 0xFFF0 && serviceId <= 0xFFF5) || // ARIB TR-B14 (GR)
                (this._targetNetworkId === 4 && serviceId === 929) // ARIB TR-B15 (BS/CS)
            ) {
                const essPmtPid = program.program_map_PID;
                this._essMap.set(serviceId, essPmtPid);

                log.debug("TSFilter#_onPAT: detected ESS PMT PID=%d as serviceId=%d", essPmtPid, serviceId);
                continue;
            }

            this._serviceIds.add(serviceId);

            const item = this._targetNetworkId === null ? null : _.service.get(this._targetNetworkId, serviceId);

            log.debug(
                "TSFilter#_onPAT: detected PMT PID=%d as serviceId=%d (%s)",
                program.program_map_PID, serviceId, item ? item.name : "unregistered"
            );

            // detect PMT PID by specific service id
            if (serviceId === this._provideServiceId) {
                if (this._pmtPid !== program.program_map_PID) {
                    this._pmtPid = program.program_map_PID;

                    if (this._providePids.has(this._pmtPid) === false) {
                        this._providePids.add(this._pmtPid);
                    }
                    if (this._parsePids.has(this._pmtPid) === false) {
                        this._parsePids.add(this._pmtPid);
                    }

                    // edit PAT section
                    data._raw.copy(this._patsec, 0, 0, 8);

                    // section_length
                    this._patsec[2] = 17; // 0x11

                    // network_number = 0
                    this._patsec[8] = 0;
                    this._patsec[9] = 0;
                    // network_PID
                    this._patsec[10] = 224;
                    this._patsec[11] = 16;

                    // program_number
                    this._patsec[12] = serviceId >> 8;
                    this._patsec[13] = serviceId & 255;
                    // program_map_PID
                    this._patsec[14] = (this._pmtPid >> 8) + 224;
                    this._patsec[15] = this._pmtPid & 255;

                    // calculate CRC32
                    this._patsec.writeInt32BE(TsCrc32.calc(this._patsec.slice(0, 16)), 16);

                    // padding
                    this._patsec.fill(0xff, 20);
                }
            }

            if (this._parseEIT && item) {
                for (const service of _.service.findByNetworkId(this._targetNetworkId)) {
                    if (this._parseServiceIds.has(service.serviceId) === false) {
                        this._parseServiceIds.add(service.serviceId);

                        log.debug("TSFilter#_onPAT: parsing serviceId=%d (%s)", service.serviceId, service.name);
                    }
                }
            }
        }

        if (this._parseSDT) {
            if (this._parsePids.has(0x11) === false) {
                this._parsePids.add(0x11);
            }
        }
    }

    private _onPMT(pid: number, data: any): void {

        if (this._essMap.has(data.program_number)) {
            for (const stream of data.streams) {
                for (const descriptor of stream.ES_info) {
                    if (descriptor.descriptor_tag === 0x52) { // stream identifier descriptor
                        if (
                            descriptor.component_tag === 0x79 || // ARIB TR-B15 (BS)
                            descriptor.component_tag === 0x7A // ...? (CS)
                        ) {
                            this._parsePids.add(stream.elementary_PID);
                            this._essEsPids.add(stream.elementary_PID);

                            log.debug("TSFilter#_onPMT: detected ESS ES PID=%d", stream.elementary_PID);
                            break;
                        }
                    }
                }
            }
            this._parsePids.delete(pid);
            return;
        }

        if (this._ready === false && this._provideServiceId !== null && this._provideEventId === null) {
            this._ready = true;

            log.info("TSFilter#_onPMT: now ready for serviceId=%d", this._provideServiceId);
        }

        if (data.program_info[0]) {
            this._providePids.add(data.program_info[0].CA_PID);
        }

        this._providePids.add(data.PCR_PID);

        for (const stream of data.streams) {
            this._providePids.add(stream.elementary_PID);
        }

        // sleep
        if (this._parsePids.has(pid)) {
            this._parsePids.delete(pid);
            this._pmtTimer = setTimeout(() => {
                this._parsePids.add(pid);
            }, 1000);
        }
    }

    private _onNIT(pid: number, data: any): void {

        const _network = {
            networkId: data.network_id,
            areaCode: -1,
            remoteControlKeyId: -1
        };

        if (data.transport_streams[0]) {
            for (const desc of data.transport_streams[0].transport_descriptors) {
                switch (desc.descriptor_tag) {
                    case 0xFA:
                        _network.areaCode = desc.area_code;
                        break;
                    case 0xCD:
                        _network.remoteControlKeyId = desc.remote_control_key_id;
                        break;
                }
            }
        }

        this.emit("network", _network);

        if (this._parsePids.has(pid)) {
            this._parsePids.delete(pid);
        }
    }

    private _onSDT(pid: number, data: any): void {

        if (this._tsid !== data.transport_stream_id) {
            return;
        }

        const _services = [];

        for (const service of data.services) {
            if (this._serviceIds.has(service.service_id) === false) {
                continue;
            }

            let name = "";
            let type = -1;
            let logoId = -1;

            const m = service.descriptors.length;
            for (let j = 0; j < m; j++) {
                if (service.descriptors[j].descriptor_tag === 0x48) {
                    name = new TsChar(service.descriptors[j].service_name_char).decode();
                    type = service.descriptors[j].service_type;
                }

                if (service.descriptors[j].descriptor_tag === 0xCF) {
                    logoId = service.descriptors[j].logo_id;
                }

                if (name !== "" && logoId !== -1) {
                    break;
                }
            }

            if (_services.some(_service => _service.id === service.service_id) === false) {
                _services.push({
                    networkId: data.original_network_id,
                    serviceId: service.service_id,
                    name: name,
                    type: type,
                    logoId: logoId
                });
            }
        }

        this.emit("services", _services);

        if (this._parsePids.has(pid)) {
            this._parsePids.delete(pid);
        }
    }

    private _onEIT(pid: number, data: any): void {

        // detect current event
        if (
            this._pmtPid !== -1 &&
            data.events.length !== 0 &&
            this._provideEventId !== null && data.table_id === 0x4E && data.section_number === 0 &&
            this._provideServiceId === data.service_id
        ) {
            if (data.events[0].event_id === this._provideEventId) {
                this._provideEventLastDetectedAt = Date.now();

                if (this._ready === false) {
                    this._ready = true;

                    log.info("TSFilter#_onEIT: now ready for eventId=%d", this._provideEventId);
                }
            } else {
                if (this._ready) {
                    log.info("TSFilter#_onEIT: closing because eventId=%d has ended...", this._provideEventId);

                    const eventId = this._provideEventId;
                    this._provideEventId = null;
                    setTimeout(() => {
                        this._ready = false;
                        this._provideEventId = eventId;
                        this._close();
                    }, this._eventEndTimeout);
                }
            }
        }

        // write EPG stream and store result
        if (
            this._parseEIT &&
            this._parseServiceIds.has(data.service_id)
        ) {
            if (!this._epg && status.epg[this._targetNetworkId] !== true) {
                status.epg[this._targetNetworkId] = true;
                this._epg = new EPG();

                // Logo
                this._standbyLogoData();
            }

            if (this._epg) {
                this._epg.write(data);

                if (!this._epgReady && data.table_id !== 0x4E && data.table_id !== 0x4F) {
                    this._updateEpgState(data);
                }
            }
        }
    }

    private _onTOT(pid: number, data: any): void {

        this._streamTime = getTimeFromMJD(data.JST_time);
    }

    private _onCDT(pid: number, data: any): void {

        if (data.data_type === 0x01) {
            // Logo
            const dataModule = new tsDataModule.TsDataModuleCdtLogo(data.data_module_byte).decode();
            if (dataModule.logo_type !== 0x05) {
                return;
            }

            log.debug("TSFilter#_onCDT: received logo data (networkId=%d, logoId=%d)", data.original_network_id, dataModule.logo_id);

            const logoData = TsLogo.decode(dataModule.data_byte);
            Service.saveLogoData(data.original_network_id, dataModule.logo_id, logoData);
        }
    }

    private _onDSMCC(pid: number, data: any): void {

        if (data.table_id === 0x3C) {
            // DDB - Download Data Block (frequently than DII)
            const ddb = data.message;

            const downloadId: number = ddb.downloadId;
            const moduleId: number = ddb.moduleId;

            const dl = this._dlDataMap.get(downloadId);
            if (!dl || dl.moduleId !== moduleId || !dl.data) {
                return;
            }

            const moduleVersion: number = ddb.moduleVersion;
            if (dl.moduleVersion !== moduleVersion) {
                this._dlDataMap.delete(downloadId);
                return;
            }

            const blockNumber: number = ddb.blockNumber;
            const blockDataByte: Buffer = ddb.blockDataByte;

            blockDataByte.copy(dl.data, DSMCC_BLOCK_SIZE * blockNumber);
            dl.loadedBytes += blockDataByte.length;

            log.debug("TSFilter#_onDSMCC: detected DDB and logo data downloading... (downloadId=%d, %d/%d bytes)", downloadId, dl.loadedBytes, dl.moduleSize);

            if (dl.loadedBytes !== dl.moduleSize) {
                return;
            }

            const dlData = dl.data;
            delete dl.data;

            const dataModule = new tsDataModule.TsDataModuleLogo(dlData).decode();
            for (const logo of dataModule.logos) {
                for (const logoService of logo.services) {
                    const service = _.service.get(logoService.original_network_id, logoService.service_id);
                    if (!service) {
                        continue;
                    }

                    service.logoId = logo.logo_id;

                    log.debug("TSFilter#_onDSMCC: received logo data (networkId=%d, logoId=%d)", service.networkId, service.logoId);

                    const logoData = new TsLogo(logo.data_byte).decode(); // png
                    Service.saveLogoData(service.networkId, service.logoId, logoData);
                    break;
                }
            }
        } else if (data.table_id === 0x3B) {
            // DII - Download Info Indication
            const dii = data.message;

            if (this._dlDataMap.has(dii.downloadId)) {
                return;
            }

            for (const module of dii.modules) {
                for (const descriptor of module.moduleInfo) {
                    // name
                    if (descriptor.descriptor_tag !== 0x02) {
                        continue;
                    }
                    // find LOGO-05 or CS_LOGO-05
                    if (
                        !LOGO_DATA_NAME_BS.equals(descriptor.text_char) &&
                        !LOGO_DATA_NAME_CS.equals(descriptor.text_char)
                    ) {
                        continue;
                    }
                    this._dlDataMap.set(dii.downloadId, {
                        downloadId: dii.downloadId,
                        // blockSize: dii.blockSize, // 4066
                        moduleId: module.moduleId,
                        moduleVersion: module.moduleVersion,
                        moduleSize: module.moduleSize,
                        loadedBytes: 0,
                        data: Buffer.alloc(module.moduleSize)
                    });

                    log.debug("TSFilter#_onDSMCC: detected DII and buffer allocated for logo data (downloadId=%d, %d bytes)", dii.downloadId, module.moduleSize);
                    break;
                }
            }
        }
    }

    private _observeProvideEvent(): void {

        // note: EIT p/f interval is max 3s. (ARIB TR-B15)
        if (Date.now() - this._provideEventLastDetectedAt < 10000) {
            this._provideEventTimeout = setTimeout(
                () => this._observeProvideEvent(),
                3000
            );
            return;
        }

        log.warn("TSFilter#_observeProvideEvent: closing because EIT p/f timed out for eventId=%d...", this._provideEventId);
        this._close();
    }

    private async _standbyLogoData(): Promise<void> {

        if (this._closed) {
            return;
        }
        if (this._logoDataTimer) {
            return;
        }
        if (this._enableParseDSMCC && this._essMap.size === 0) {
            return;
        }

        // target service(s)
        const targetServices: ServiceItem[] = [];
        if (this._provideServiceId === null) {
            targetServices.push(..._.service.findByNetworkId(this._targetNetworkId));
        } else if (this._enableParseCDT) {
            targetServices.push(_.service.get(this._targetNetworkId, this._provideServiceId));
        } else if (this._enableParseDSMCC && this._targetNetworkId === 4) {
            targetServices.push(
                ..._.service.findByNetworkId(4),
                ..._.service.findByNetworkId(6),
                ..._.service.findByNetworkId(7)
            );
        }

        const logoIdNetworkMap: { [networkId: number]: Set<number> } = {};

        for (const service of targetServices) {
            if (typeof service.logoId === "number") {
                if (!logoIdNetworkMap[service.networkId]) {
                    logoIdNetworkMap[service.networkId] = new Set();
                }
                logoIdNetworkMap[service.networkId].add(service.logoId);
            }
        }

        const now = Date.now();
        const logoDataInterval = _.config.server.logoDataInterval || 1000 * 60 * 60 * 24 * 7; // 7 days

        for (const networkId in logoIdNetworkMap) {
            for (const logoId of logoIdNetworkMap[networkId]) {
                if (logoId === -1 && logoIdNetworkMap[networkId].size > 1) {
                    continue;
                }

                // check logoDataInterval
                if (now - await Service.getLogoDataMTime(this._targetNetworkId, logoId) > logoDataInterval) {
                    if (this._closed) {
                        return; // break all loops
                    }

                    if (this._enableParseCDT) {
                        // for GR
                        if (logoId >= 0) {
                            this._parsePids.add(0x29); // CDT PID
                        }

                        // add listener
                        this._parser.on("cdt", this._onCDT.bind(this));

                        // add timer
                        this._logoDataTimer = setTimeout(() => {
                            this._parsePids.delete(0x29); // CDT
                            this._parser.removeAllListeners("cdt");

                            log.info("TSFilter#_standbyLogoData: stopped waiting for logo data (networkId=%d, logoId=%d)", this._targetNetworkId, logoId);
                        }, 1000 * 60 * 30); // 30 mins

                        log.info("TSFilter#_standbyLogoData: waiting for logo data for 30 minutes... (networkId=%d, logoId=%d)", this._targetNetworkId, logoId);
                    } else if (this._enableParseDSMCC) {
                        // for BS/CS
                        for (const essPmtPid of this._essMap.values()) {
                            this._parsePids.add(essPmtPid); // ESS PMT PID
                        }

                        // add listener
                        this._parser.on("dsmcc", this._onDSMCC.bind(this));

                        // add timer
                        this._logoDataTimer = setTimeout(() => {
                            delete this._logoDataTimer;

                            for (const essEsPid of this._essEsPids.values()) {
                                this._parsePids.delete(essEsPid);
                            }
                            this._parser.removeAllListeners("dsmcc");

                            log.info("TSFilter#_standbyLogoData: stopped waiting for logo data (networkId=[4,6,7])");
                        }, 1000 * 60 * 30); // 30 mins

                        log.info("TSFilter#_standbyLogoData: waiting for logo data for 30 minutes... (networkId=[4,6,7])");
                    }

                    return; // break all loops
                }
            }
        }
    }

    private _updateEpgState(data: any): void {

        const networkId = data.original_network_id;
        const serviceId = data.service_id;
        const versionNumber = data.version_number;

        const stateByNet = this._epgState[networkId] || (this._epgState[networkId] = {});
        let stateBySrv = stateByNet[serviceId];

        if (!stateByNet[serviceId]) {
            stateBySrv = stateByNet[serviceId] = {
                basic: {
                    flags: [],
                    lastFlagsId: -1
                },
                extended: {
                    flags: [],
                    lastFlagsId: -1
                }
            };

            for (let i = 0; i < 0x08; i++) {
                for (const target of [stateBySrv.basic, stateBySrv.extended]) {
                    target.flags.push({
                        flag: Buffer.alloc(32, 0x00),
                        ignore: Buffer.alloc(32, 0xFF),
                        version_number: -1
                    });
                }
            }
        }

        const flagsId = data.table_id & 0x07;
        const lastFlagsId = data.last_table_id & 0x07;
        const segmentNumber = data.section_number >> 3;
        const lastSegmentNumber = data.last_section_number >> 3;
        const sectionNumber = data.section_number & 0x07;
        const segmentLastSectionNumber = data.segment_last_section_number & 0x07;
        const targetFlags = (data.table_id & 0x0F) < 0x08 ? stateBySrv.basic : stateBySrv.extended;
        const targetFlag = targetFlags.flags[flagsId];

        if ((targetFlags.lastFlagsId !== lastFlagsId) ||
            (targetFlag.version_number !== -1 && targetFlag.version_number !== versionNumber)) {
            // version check
            if (targetFlag.version_number !== -1) {
                const verDiff = versionNumber - targetFlag.version_number;
                if (verDiff === -1 || verDiff > 1) {
                    return;
                }
            }
            // reset fields
            for (let i = 0; i < 0x08; i++) {
                targetFlags.flags[i].flag.fill(0x00);
                targetFlags.flags[i].ignore.fill(i <= lastFlagsId ? 0x00 : 0xFF);
            }
        }

        // update ignore field (past segment)
        if (flagsId === 0 && this._streamTime !== null) {
            const segment = (this._streamTime + 9 * 60 * 60 * 1000) / (3 * 60 * 60 * 1000) & 0x07;

            for (let i = 0; i < segment; i++) {
                targetFlag.ignore[i] = 0xFF;
            }
        }

        // update ignore field (segment)
        for (let i = lastSegmentNumber + 1; i < 0x20 ; i++) {
            targetFlag.ignore[i] = 0xFF;
        }

        // update ignore field (section)
        for (let i = segmentLastSectionNumber + 1; i < 8; i++) {
            targetFlag.ignore[segmentNumber] |= 1 << i;
        }

        // update flag field
        targetFlag.flag[segmentNumber] |= 1 << sectionNumber;

        // update last_table_id & version_number
        targetFlags.lastFlagsId = lastFlagsId;
        targetFlag.version_number = versionNumber;

        let ready = true;
        isReady: for (const nid in this._epgState) {
            for (const sid in this._epgState[nid]) {
                for (const table of [...this._epgState[nid][sid].basic.flags, ...this._epgState[nid][sid].extended.flags]) {
                    for (let i = 0; i < table.flag.length; i++) {
                        if ((table.flag[i] | table.ignore[i]) !== 0xFF) {
                            ready = false;
                            break isReady;
                        }
                    }
                }
            }
        }

        if (ready === true) {
            this._epgReady = true;

            for (const service of _.service.findByNetworkId(this._targetNetworkId)) {
                service.epgReady = true;
            }

            process.nextTick(() => this.emit("epgReady"));
        }
    }

    private _close(): void {

        if (this._closed) {
            return;
        }
        this._closed = true;

        // clear timer
        clearTimeout(this._pmtTimer);
        clearTimeout(this._provideEventTimeout);
        clearTimeout(this._logoDataTimer);

        // clear buffer
        setImmediate(() => {
            this._patsec.fill(0);
            delete this._patsec;
            this._packet.fill(0);
            delete this._packet;
            delete this._buffer;
            delete this._parses;
        });

        // clear parser instance
        this._parser.removeAllListeners();
        this._parser.end();
        delete this._parser;

        // clear EPG instance & state
        if (this._epg) {
            this._epg.end();
            delete this._epg;
            status.epg[this._targetNetworkId] = false; // update status

            if (this._epgReady === true) {
                const now = Date.now();
                for (const service of _.service.findByNetworkId(this._targetNetworkId)) {
                    service.epgUpdatedAt = now;
                }
            }
        }

        // clear streamInfo
        delete this.streamInfo;

        --status.streamCount.tsFilter;

        log.info("TSFilter#_close: closed (serviceId=%s, eventId=%s)", this._provideServiceId, this._provideEventId);

        // close
        this.emit("close");
        this.emit("end");
    }
}
