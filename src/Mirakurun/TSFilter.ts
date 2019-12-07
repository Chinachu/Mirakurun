/*
   Copyright 2016 Yuki KAN

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
import * as log from "./log";
import epg from "./epg";
import status from "./status";
import _ from "./_";
import ProgramItem from "./ProgramItem";
import ServiceItem from "./ServiceItem";
import * as aribts from "aribts";
const calcCRC32: (buf: Buffer) => number = aribts.TsCrc32.calc;

interface StreamOptions extends stream.DuplexOptions {
    readonly networkId?: number;
    readonly serviceId?: number;
    readonly eventId?: number;
    readonly noProvide?: boolean;
    readonly parseNIT?: boolean;
    readonly parseSDT?: boolean;
    readonly parseEIT?: boolean;
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

// BS/CS logo
class DownloadLogoData {
    done: boolean = false;
    moduleSize: number;
    moduleVersion: number;
    blocks: Buffer[] = [];
    constructor(moduleDII: any) {
        this.moduleSize = moduleDII.moduleSize;
        this.moduleVersion = moduleDII.moduleVersion;
    }
}
function MakeDownloadLogoDatasKey(downloadId: number, moduleId: number, moduleVersion: number): string {
    return downloadId.toString(10) + "_" + moduleId.toString(10) + "_" + moduleVersion.toString(10);
}

export default class TSFilter extends stream.Duplex {

    // options
    private _provideServiceId: number;
    private _provideEventId: number;
    private _parseNIT: boolean = false;
    private _parseSDT: boolean = false;
    private _parseEIT: boolean = false;
    private _targetNetworkId: number;

    // aribts
    private _parser: stream.Transform = new aribts.TsStream();

    // buffer
    private _packet: Buffer = Buffer.allocUnsafe(PACKET_SIZE);
    private _offset: number = -1;
    private _buffer: Buffer[] = [];
    private _parses: Buffer[] = [];
    private _patsec: Buffer = Buffer.allocUnsafe(PACKET_SIZE - 4 - 1); // TS header, pointer_field

    // state
    private _closed: boolean = false;
    private _ready: boolean = true;
    private _providePids: number[] = null; // `null` to provides all
    private _parsePids: number[] = [];
    private _tsid: number = -1;
    private _patCRC: Buffer = Buffer.allocUnsafe(0);
    private _serviceIds: number[] = [];
    private _parseServiceIds: number[] = [];
    private _pmtPid: number = -1;
    private _pmtTimer: NodeJS.Timer;
    private _streamTime: number = null;
    private _epgReady: boolean = false;
    private _epgState: { [networkId: number]: { [serviceId: number]: BasicExtState } } = {};
    private _overflowTimer: NodeJS.Timer = null;
    private _provideEventLastDetectedAt: number = -1;
    private _provideEventTimeout: NodeJS.Timer = null;

    // stream options
    private highWaterMark: number = _.config.server.highWaterMark || 1024 * 1024 * 24;
    private _overflowTimeLimit: number = _.config.server.overflowTimeLimit || 1000 * 30;
    /** Number divisible by a multiple of 188 */
    private _maxBufferBytesBeforeReady: number = (() => {
        let bytes = _.config.server.maxBufferBytesBeforeReady || 1024 * 1024 * 3;
        bytes = bytes - bytes % PACKET_SIZE;
        return bytes;
    })();
    private _eventEndTimeout: number = _.config.server.eventEndTimeout || 1000;

    // ReadableState in node/lib/_stream_readable.js
    private _readableState: any;

    // BS/CS logo
    private _downloadLogoDatas: Map<string, DownloadLogoData> = null;

    constructor(options: StreamOptions) {
        super({
            allowHalfOpen: false
        });

        this._targetNetworkId = options.networkId || null;
        this._provideServiceId = options.serviceId || null;
        this._provideEventId = options.eventId || null;

        log.debug(`construct TSFilter _provideServiceId=${this._provideServiceId}`);
        if (this._provideServiceId !== null) {
            this._providePids = [...PROVIDE_PIDS];
            this._ready = false;
        }
        if (this._provideEventId !== null) {
            this._ready = false;

            const program = _.program.get(
                ProgramItem.getId(
                    this._targetNetworkId,
                    this._provideServiceId,
                    this._provideEventId
                )
            );
            if (program) {
                this._provideEventTimeout = setTimeout(
                    () => this._observeProvideEvent(),
                    program.data.startAt + program.data.duration - Date.now()
                );
            }
        }
        if (options.noProvide === true) {
            this._provideServiceId = null;
            this._provideEventId = null;
            this._providePids = [];
            this._ready = false;
        }
        if (options.parseNIT === true) {
            this._parseNIT = true;
        }
        if (options.parseSDT === true) {
            this._parseSDT = true;
        }
        if (options.parseEIT === true) {
            if (this._targetNetworkId === null) {
                this._parseEIT = true;
            } else if (status.epg[this._targetNetworkId] !== true) {
                status.epg[this._targetNetworkId] = true;
                this._parseEIT = true;
            }
        }

        this._parser.resume();
        this._parser.on("pat", this._onPAT.bind(this));
        this._parser.on("pmt", this._onPMT.bind(this));
        this._parser.on("nit", this._onNIT.bind(this));
        this._parser.on("sdt", this._onSDT.bind(this));
        this._parser.on("eit", this._onEIT.bind(this));
        this._parser.on("tot", this._onTOT.bind(this));
        this._parser.on("cdt", this._onCDT.bind(this));
        this._parser.on("dsmcc", this._onDSMCC.bind(this));

        this.once("finish", this._close.bind(this));
        this.once("close", this._close.bind(this));

        log.info("TSFilter has created (serviceId=%s, eventId=%s)", this._provideServiceId, this._provideEventId);

        if (this._ready === false) {
            log.debug("TSFilter is waiting for serviceId=%s, eventId=%s", this._provideServiceId, this._provideEventId);
        }

        ++status.streamCount.tsFilter;
    }

    _read(size: number) {

        if (this._closed === true) {
            this.push(null);
        }
    }

    _write(chunk: Buffer, encoding: string, callback: Function) {

        if (this._closed === true) {
            callback(new Error("TSFilter has closed already"));
            return;
        }

        // stringent safety measure
        if (this._readableState.length > this.highWaterMark) {
            log.warn("TSFilter is overflowing the buffer...");

            if (this._overflowTimer === null) {
                this._overflowTimer = setTimeout(() => {
                    log.error("TSFilter will closing because reached time limit of overflowing the buffer...");
                    this._close();
                }, this._overflowTimeLimit);
            }

            callback();  // just drop the chunk
            ++status.errorCount.bufferOverflow;
            return;
        }
        if (this._overflowTimer !== null) {
            clearTimeout(this._overflowTimer);
            this._overflowTimer = null;
        }

        let offset = 0;
        const length = chunk.length;

        if (this._offset > 0) {
            if (length >= PACKET_SIZE - this._offset) {
                chunk.copy(this._packet, this._offset, 0, PACKET_SIZE - this._offset);
                this._processPacket(this._packet);
                offset = PACKET_SIZE - this._offset;
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
            if (this._ready === true) {
                this.push(Buffer.concat(this._buffer));
                this._buffer = [];
            } else {
                this._buffer = [Buffer.concat(this._buffer)];
                if (this._buffer[0].length > this._maxBufferBytesBeforeReady) {
                    this._buffer[0] = this._buffer[0].slice(this._buffer[0].length - this._maxBufferBytesBeforeReady);
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

        // NULL
        if (pid === 0x1FFF) {
            return;
        }

        packet = Buffer.from(packet);

        // parse
        if (pid === 0 && this._patCRC.compare(packet.slice(packet[7] + 4, packet[7] + 8))) {
            this._patCRC = Buffer.from(packet.slice(packet[7] + 4, packet[7] + 8));
            this._parses.push(packet);
        } else if (
            ((pid === 0x12 || pid === 0x29) && (this._parseEIT === true || this._provideEventId !== null)) ||
            pid === 0x14 ||
            pid === 0x0779 ||   // Dpa BS common
            this._parsePids.indexOf(pid) !== -1
        ) {
            this._parses.push(packet);
        }

        if (this._ready === false && (pid === 0x12 || this._provideEventId === null)) {
            return;
        }
        if (this._providePids !== null && this._providePids.indexOf(pid) === -1) {
            return;
        }

        // PAT (0) rewriting
        if (pid === 0 && this._pmtPid !== -1) {
            this._patsec.copy(packet, 5, 0);
        }

        this._buffer.push(packet);
    }

    private _onPAT(pid: number, data: any): void {

        this._tsid = data.transport_stream_id;
        this._serviceIds = [];
        this._parseServiceIds = [];

        const l = data.programs.length;
        for (let i = 0; i < l; i++) {
            let item: ServiceItem;
            const id = data.programs[i].program_number as number;

            if (id === 0) {
                const NIT_PID = data.programs[i].network_PID;

                log.debug("TSFilter detected NIT PID=%d", NIT_PID);

                if (this._parseNIT === true) {
                    if (this._parsePids.indexOf(NIT_PID) === -1) {
                        this._parsePids.push(NIT_PID);
                    }
                }
                continue;
            }

            this._serviceIds.push(id);
            if (this._targetNetworkId === null) {
                item = null;
            } else {
                item = _.service.get(this._targetNetworkId, id);
            }

            log.debug(
                "TSFilter detected PMT PID=%d as serviceId=%d (%s)",
                data.programs[i].program_map_PID, id, item ? item.name : "unregistered"
            );

            // detect PMT PID by specific service id
            if (this._provideServiceId === id) {
                if (this._pmtPid !== data.programs[i].program_map_PID) {
                    this._pmtPid = data.programs[i].program_map_PID;

                    if (this._providePids.indexOf(this._pmtPid) === -1) {
                        this._providePids.push(this._pmtPid);
                    }
                    if (this._parsePids.indexOf(this._pmtPid) === -1) {
                        this._parsePids.push(this._pmtPid);
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
                    this._patsec[12] = id >> 8;
                    this._patsec[13] = id & 255;
                    // program_map_PID
                    this._patsec[14] = (this._pmtPid >> 8) + 224;
                    this._patsec[15] = this._pmtPid & 255;

                    // calculate CRC32
                    this._patsec.writeInt32BE(calcCRC32(this._patsec.slice(0, 16)), 16);

                    // padding
                    this._patsec.fill(0xff, 20);
                }
            }

            if (this._parseEIT === true && item) {
                _.service.findByNetworkId(this._targetNetworkId).forEach(service => {
                    if (this._parseServiceIds.indexOf(service.serviceId) === -1) {
                        this._parseServiceIds.push(service.serviceId);

                        log.debug("TSFilter parsing serviceId=%d (%s)", service.serviceId, service.name);
                    }
                });
            }
        }

        if (this._parseSDT === true) {
            if (this._parsePids.indexOf(0x11) === -1) {
                this._parsePids.push(0x11);
            }
        }
    }

    private _onPMT(pid: number, data: any): void {

        if (this._ready === false && this._provideServiceId !== null && this._provideEventId === null) {
            this._ready = true;

            log.info("TSFilter is now ready for serviceId=%d", this._provideServiceId);
        }

        if (data.program_info[0]) {
            if (this._providePids.indexOf(data.program_info[0].CA_PID) === -1) {
                this._providePids.push(data.program_info[0].CA_PID);
            }
        }

        if (this._providePids.indexOf(data.PCR_PID) === -1) {
            this._providePids.push(data.PCR_PID);
        }

        const l = data.streams.length;
        for (let i = 0; i < l; i++) {
            if (this._providePids.indexOf(data.streams[i].elementary_PID) === -1) {
                this._providePids.push(data.streams[i].elementary_PID);
            }
        }

        // sleep
        const index = this._parsePids.indexOf(pid);
        if (index !== -1) {
            this._parsePids.splice(index, 1);

            this._pmtTimer = setTimeout(() => {
                this._parsePids.push(pid);
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

        const index = this._parsePids.indexOf(pid);
        if (index !== -1) {
            this._parsePids.splice(index, 1);
        }
    }

    private _onSDT(pid: number, data: any): void {

        if (this._tsid !== data.transport_stream_id) {
            return;
        }

        const _services = [];

        const l = data.services.length;
        for (let i = 0; i < l; i++) {
            const service = data.services[i];

            if (this._serviceIds.indexOf(service.service_id) === -1) {
                continue;
            }

            let name = "";
            let type = -1;
            let logoId = -1;

            const m = service.descriptors.length;
            for (let j = 0; j < m; j++) {
                if (service.descriptors[j].descriptor_tag === 0x48) {
                    name = new aribts.TsChar(service.descriptors[j].service_name_char).decode();
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

        const index = this._parsePids.indexOf(pid);
        if (index !== -1) {
            this._parsePids.splice(index, 1);
        }
    }

    private _onEIT(pid: number, data: any): void {

        // detect current event
        if (
            data.events.length !== 0 &&
            this._provideEventId !== null && data.table_id === 0x4E && data.section_number === 0 &&
            this._provideServiceId === data.service_id
        ) {
            if (data.events[0].event_id === this._provideEventId) {
                this._provideEventLastDetectedAt = Date.now();

                if (this._ready === false) {
                    this._ready = true;

                    log.info("TSFilter is now ready for eventId=%d", this._provideEventId);
                }
            } else {
                if (this._ready === true) {
                    log.info("TSFilter is closing because eventId=%d has ended...", this._provideEventId);

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
            this._parseEIT === true &&
            this._parseServiceIds.indexOf(data.service_id) !== -1 &&
            data.table_id !== 0x4E && data.table_id !== 0x4F
        ) {
            epg.write(data);

            if (!this._epgReady) {
                this._updateEpgState(data);
            }
        }
    }

    private _onTOT(pid: number, data: any): void {

        this._streamTime = getTime(data.JST_time);
    }

    private _onCDT(pid: number, data: any): void {

        if (data.data_type === 0x01) {
            // Logo
            const dataModule = new aribts.tsDataModule.TsDataModuleCdtLogo(data.data_module_byte).decode();
            if (dataModule.logo_type !== 0x05) {
                return;
            }

            log.debug("TSFilter detected CDT networkId=%d, logoId=%d", data.original_network_id, dataModule.logo_id);

            const logoData = new aribts.TsLogo(dataModule.data_byte).decode();

            _.service.findByNetworkIdWithLogoId(data.original_network_id, dataModule.logo_id).forEach(service => {
                service.logoData = logoData;

                log.info("TSFilter updated serviceId=%d logo data", service.serviceId);
            });
        }
    }

    private _onDSMCC(pid: number, data: any): void {
        log.debug(`dsmcc pid=${pid} ${data}`);
        switch (data.table_id) {
            case 0x3B:
                // DII
                this._onDSMCC_DII(pid, data);
                break;
            case 0x3C:
                // DDB
                this._onDSMCC_DDB(pid, data);
                break;
        }
    }

    private _onDSMCC_DII(pid: number, data: any): void {
        const objDii = data.message;
        for (const module of objDii.modules) {
            for (const descriptor of module.moduleInfo) {
                // Name
                if (descriptor.descriptor_tag !== 0x02) {
                    continue;
                }

                // filename "CS_LOGO-05" or "LOGO-05" (logo_type = 5)
                if (descriptor.text_char.length !== 7 && descriptor.text_char.length !== 10) {
                    continue;
                }
                if (descriptor.text_char.toString().indexOf("LOGO-05") === -1) {
                    continue;
                }

                const key = MakeDownloadLogoDatasKey(objDii.downloadId, module.moduleId, module.moduleVersion);

                log.debug("TSFilter detected DSM-CC BS/CS logo DII PID=%d downloadId=%d moduleId=%d moduleVersion=%d date=%s",
                    pid, objDii.downloadId, module.moduleId, module.moduleVersion, new Date(this._streamTime).toISOString());

                if (this._downloadLogoDatas === null) {
                    this._downloadLogoDatas = new Map<string, DownloadLogoData>();
                }

                if (!this._downloadLogoDatas.has(key)) {
                    this._downloadLogoDatas.set(key, new DownloadLogoData(module));

                    log.debug("TSFilter reserved downloading BS/CS logo PID=%d downloadId=%d moduleId=%d moduleVersion=%d date=%s",
                        pid, objDii.downloadId, module.moduleId, module.moduleVersion, new Date(this._streamTime).toISOString());
                }
            }   // descriptor of module.moduleInfo
        }   // module of objDii.modules
    }

    private _onDSMCC_DDB(pid: number, data: any): void {
        if (this._downloadLogoDatas === null) {
            return;
        }

        const objDdb = data.message;

        const key = MakeDownloadLogoDatasKey(objDdb.downloadId, objDdb.moduleId, objDdb.moduleVersion);
        if (!this._downloadLogoDatas.has(key)) {
            return;
        }
        if (this._downloadLogoDatas.get(key).done) {
            return;
        }

        const downloadLogoData = this._downloadLogoDatas.get(key);

        downloadLogoData.blocks[objDdb.blockNumber] = objDdb.blockDataByte;

        let downloadedModuleSize = 0;
        downloadLogoData.blocks.forEach(block => downloadedModuleSize += block ? block.length : 0);

        log.debug("TSFilter download BS/CS logo PID=%d downloadId=%d moduleId=%d moduleVersion=%d date=%s moduleSize=%d/%d",
            pid, objDdb.downloadId, objDdb.moduleId, objDdb.moduleVersion, new Date(this._streamTime).toISOString(),
            downloadedModuleSize, downloadLogoData.moduleSize);

        if (downloadedModuleSize !== downloadLogoData.moduleSize) {
            return;
        }

        const dataModuleByte = Buffer.concat(downloadLogoData.blocks);

        const dataModule = new aribts.tsDataModule.TsDataModuleLogo(dataModuleByte).decode();

        for (const logo of dataModule.logos) {

            // png
            const logoData = new aribts.TsLogo(logo.data_byte).decode();

            for (const logoService of logo.services) {

                const service = _.service.get(logoService.original_network_id, logoService.service_id);
                if (service === null) {
                    continue;
                }

                log.debug("TSFilter service onid=%d tsid=%d sid=%d",
                    logoService.original_network_id, logoService.transport_stream_id, logoService.service_id);

                service.logoData = logoData;
                service.logoId = logo.logo_id;

                log.info("TSFilter updated networkId=%d serviceId=%d logo data", service.networkId, service.serviceId);
            }   // logoService of logo.services
        }   // logo of dataModule.logos
        downloadLogoData.done = true;
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

        log.warn("TSFilter is closing because EIT p/f timed out for eventId=%d...", this._provideEventId);
        this._close();
    }

    private _updateEpgState(data: any): void {

        const networkId = data.original_network_id;
        const serviceId = data.service_id;
        const versionNumber = data.version_number;

        if (this._epgState[networkId] === undefined) {
            this._epgState[networkId] = {};
        }

        if (this._epgState[networkId][serviceId] === undefined) {
            this._epgState[networkId][serviceId] = {
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
                [this._epgState[networkId][serviceId].basic, this._epgState[networkId][serviceId].extended].forEach(target => {
                    target.flags.push({
                        flag: Buffer.alloc(32, 0x00),
                        ignore: Buffer.alloc(32, 0xFF),
                        version_number: -1
                    });
                });
            }
        }

        const flagsId = data.table_id & 0x07;
        const lastFlagsId = data.last_table_id & 0x07;
        const segmentNumber = data.section_number >> 3;
        const lastSegmentNumber = data.last_section_number >> 3;
        const sectionNumber = data.section_number & 0x07;
        const segmentLastSectionNumber = data.segment_last_section_number & 0x07;
        const targetFlags = (data.table_id & 0x0F) < 0x08 ? this._epgState[networkId][serviceId].basic : this._epgState[networkId][serviceId].extended;
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

        this._epgReady = Object.keys(this._epgState).every(nid => {
            return Object.keys(this._epgState[nid]).every(sid => {
                return [this._epgState[nid][sid].basic, this._epgState[nid][sid].extended].every(target => {
                    return target.flags.every(table => {
                        return table.flag.every((segment, i) => {
                            return (segment | table.ignore[i]) === 0xFF;
                        });
                    });
                });
            });
        });

        if (this._epgReady) {
            process.nextTick(() => this.emit("epgReady"));
        }
    }

    private _close(): void {

        if (this._closed === true) {
            return;
        }
        this._closed = true;

        // clear timer
        clearTimeout(this._pmtTimer);
        clearTimeout(this._provideEventTimeout);

        // clear buffer
        setImmediate(() => {
            this._readableState.buffer = [];
            this._readableState.length = 0;
            this._patsec.fill(0);
            this._patsec = null;
            this._packet.fill(0);
            this._packet = null;
            this._buffer = null;
            this._parses = null;
        });

        // clear instance
        this._parser.removeAllListeners();
        this._parser.end();
        this._parser = null;

        // update status
        if (this._parseEIT === true && this._targetNetworkId !== null) {
            status.epg[this._targetNetworkId] = false;
        }

        // close
        process.nextTick(() => {
            this.emit("close");
            this.emit("end");
        });

        log.info("TSFilter has closed (serviceId=%s, eventId=%s)", this._provideServiceId, this._provideEventId);

        --status.streamCount.tsFilter;
    }
}

function getTime(buffer: Buffer): number {

    const mjd = (buffer[0] << 8) | buffer[1];

    let y = (((mjd - 15078.2) / 365.25) | 0);
    let m = (((mjd - 14956.1 - ((y * 365.25) | 0)) / 30.6001) | 0);
    const d = mjd - 14956 - ((y * 365.25) | 0) - ((m * 30.6001) | 0);

    const k = (m === 14 || m === 15) ? 1 : 0;

    y = y + k + 1900;
    m = m - 1 - k * 12;

    const h = (buffer[2] >> 4) * 10 + (buffer[2] & 0x0F);
    const i = (buffer[3] >> 4) * 10 + (buffer[3] & 0x0F);
    const s = (buffer[4] >> 4) * 10 + (buffer[4] & 0x0F);

    return new Date(y, m - 1, d, h, i, s).getTime();
}
