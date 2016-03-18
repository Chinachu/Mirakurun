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
/// <reference path="../../typings/node/node.d.ts" />
'use strict';

import stream = require('stream');
import log = require('./log');
const aribts = require('aribts');

interface StreamOptions extends stream.DuplexOptions {
    serviceId?: number;
    eventId?: number;
}

const PACKET_SIZE = 188;

const PROVIDE_PIDS = [
    0x0000,// PAT
    0x0001,// CAT
    0x0010,// NIT
    0x0011,// SDT
    0x0012,// EIT
    0x0013,// RST
    0x0014,// TDT
    0x0023,// SDTT
    0x0024,// BIT
    0x0028// SDTT
];

class TSFilter extends stream.Duplex {

    // aribts
    private _parser: stream.Transform = new aribts.TsStream();
    //private _tsUtil = new aribts.TsUtil();

    // buffer
    private _packet: Buffer = new Buffer(PACKET_SIZE);
    private _offset: number = -1;
    private _buffer: Buffer[] = [];
    private _patsec: Buffer = new Buffer(20);

    // state
    private _closed: boolean = false;
    private _ready: boolean = true;
    private _networkPid: number = 0;
    private _serviceId: number;
    private _eventId: number;
    private _providePids: number[] = null;// `null` to provides all
    private _parsePids: number[] = [];
    private _patCRC: number = -1;
    private _pmtPid: number = -1;
    private _timer: any = {};

    // stream options
    private highWaterMark: number = 1024 * 1024 * 4;

    // ReadableState in node/lib/_stream_readable.js
    private _readableState: any;

    constructor(options: StreamOptions) {
        super();

        this._serviceId = options.serviceId || null;
        this._eventId = options.eventId || null;

        if (this._serviceId !== null) {
            this._providePids = PROVIDE_PIDS.concat();
            this._ready = false;
        }
        if (this._eventId !== null) {
            this._ready = false;
        }

        this._parser.resume();
        this._parser.on('pat', this._onPAT.bind(this));
        this._parser.on('pmt', this._onPMT.bind(this));

        this.once('finish', this._close.bind(this));
        this.once('close', this._close.bind(this));

        log.debug('TSFilter has created (serviceId=%s, eventId=%s)', this._serviceId, this._eventId);
    }

    _read(size: number) {

        if (this._closed === true) {
            this.push(null);
            return;
        }
    }

    _write(chunk: Buffer, encoding, callback: Function) {

        // stringent safety measure
        if (this._readableState.length > this.highWaterMark) {
            log.error('TSFilter closing because overflowing the buffer...');
            return this._close();
        }

        let offset = 0, length = chunk.length;

        if (this._offset > 0) {
            chunk.copy(this._packet, this._offset, 0, PACKET_SIZE - this._offset);
            this._processPacket(this._packet);
            offset += PACKET_SIZE - this._offset;
            this._offset = 0;
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
                this._offset = -1;
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
            this.push(Buffer.concat(this._buffer));
            this._buffer = [];
        }

        callback();
    }

    private _processPacket(packet: Buffer): void {

        const pid = packet.readUInt16BE(1) & 0x1fff;

        // NULL (0x1fff)
        if (pid === 8191) {
            return;
        }

        // parse
        if (pid === 0 && this._patCRC !== packet.readInt32BE(packet[7] + 4)) {
            this._patCRC = packet.readInt32BE(packet[7] + 4);
            this._parser.write(packet);
        } else if (this._parsePids.indexOf(pid) !== -1) {
            this._parser.write(packet);
        }

        if (this._ready === false) {
            return;
        }
        if (this._providePids !== null && this._providePids.indexOf(pid) === -1) {
            return;
        }

        // PAT (0) rewriting
        if (pid === 0 && this._pmtPid !== -1) {
            this._patsec.copy(packet, 5, 0);

            // 0xFF padding
            //packet.fill(255, 25);
        }

        this._buffer.push(new Buffer(packet));
    }

    private _onPAT(pid, data): void {

        let i = 0, l = data.programs.length;
        for (; i < l; i++) {
            if (data.programs[i].program_number === 0) {
                this._networkPid = data.programs[i].network_PID;

                log.debug(
                    'TSFilter detected Network PID=%d',
                    this._networkPid
                );

                if (this._providePids !== null && this._providePids.indexOf(this._networkPid) === -1) {
                    this._providePids.push(this._networkPid);
                }

                continue;
            }

            log.debug(
                'TSFilter detected PMT PID=%d as serviceId=%d',
                data.programs[i].program_number, data.programs[i].program_map_PID
            );

            // detect PMT PID by specific service id
            if (this._serviceId === data.programs[i].program_number) {
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
                    this._patsec[2] = 17;// 0x11

                    // network_number = 0
                    this._patsec[8] = 0;
                    this._patsec[9] = 0;
                    // network_PID
                    this._patsec[10] = (this._networkPid >> 8) + 224;
                    this._patsec[11] = this._networkPid & 255;

                    // program_number
                    this._patsec[12] = this._serviceId >> 8;
                    this._patsec[13] = this._serviceId & 255;
                    // program_map_PID
                    this._patsec[14] = (this._pmtPid >> 8) + 224;
                    this._patsec[15] = this._pmtPid & 255

                    // calculate CRC32
                    this._patsec.writeInt32BE(calcCRC32(this._patsec.slice(0, 16)), 16);
                }
            }
        }
    }

    private _onPMT(pid, data): void {

        if (this._ready === false && this._serviceId !== null && this._eventId === null) {
            this._ready = true;
        }

        if (this._providePids.indexOf(data.program_info[0].CA_PID) === -1) {
            this._providePids.push(data.program_info[0].CA_PID);
        }

        if (this._providePids.indexOf(data.PCR_PID) === -1) {
            this._providePids.push(data.PCR_PID);
        }

        let i = 0, l = data.streams.length;
        for (; i < l; i++) {
            if (this._providePids.indexOf(data.streams[i].elementary_PID) === -1) {
                this._providePids.push(data.streams[i].elementary_PID);
            }
        }

        // sleep
        i = this._parsePids.indexOf(pid);
        if (i !== -1) {
            this._parsePids.splice(i, 1);

            this._timer.onPMT = setTimeout(() => {
                this._parsePids.push(pid);
            }, 1000);
        }
    }

    private _close(): void {

        if (this._closed === true) {
            return;
        }
        this._closed = true;

        // clear timer
        clearTimeout(this._timer.onPMT);

        // clear buffer
        this._readableState.buffer = [];
        this._readableState.length = 0;
        this._patsec.fill(0);
        this._patsec = null;
        this._packet.fill(0);
        this._packet = null;
        this._buffer.forEach(packet => {
            packet.fill(0);
            packet = null;
        });
        this._buffer = null;

        this._parser.removeAllListeners();
        this._parser.end();
        this._parser = null;
        //this._tsUtil = null;

        this.emit('close');

        log.debug('TSFilter has closed (serviceId=%s, eventId=%s)', this._serviceId, this._eventId);
    }
}

const CRC32_TABLE = [
    0x00000000, 0x04C11DB7, 0x09823B6E, 0x0D4326D9, 0x130476DC, 0x17C56B6B, 0x1A864DB2, 0x1E475005,
    0x2608EDB8, 0x22C9F00F, 0x2F8AD6D6, 0x2B4BCB61, 0x350C9B64, 0x31CD86D3, 0x3C8EA00A, 0x384FBDBD,
    0x4C11DB70, 0x48D0C6C7, 0x4593E01E, 0x4152FDA9, 0x5F15ADAC, 0x5BD4B01B, 0x569796C2, 0x52568B75,
    0x6A1936C8, 0x6ED82B7F, 0x639B0DA6, 0x675A1011, 0x791D4014, 0x7DDC5DA3, 0x709F7B7A, 0x745E66CD,
    0x9823B6E0, 0x9CE2AB57, 0x91A18D8E, 0x95609039, 0x8B27C03C, 0x8FE6DD8B, 0x82A5FB52, 0x8664E6E5,
    0xBE2B5B58, 0xBAEA46EF, 0xB7A96036, 0xB3687D81, 0xAD2F2D84, 0xA9EE3033, 0xA4AD16EA, 0xA06C0B5D,
    0xD4326D90, 0xD0F37027, 0xDDB056FE, 0xD9714B49, 0xC7361B4C, 0xC3F706FB, 0xCEB42022, 0xCA753D95,
    0xF23A8028, 0xF6FB9D9F, 0xFBB8BB46, 0xFF79A6F1, 0xE13EF6F4, 0xE5FFEB43, 0xE8BCCD9A, 0xEC7DD02D,
    0x34867077, 0x30476DC0, 0x3D044B19, 0x39C556AE, 0x278206AB, 0x23431B1C, 0x2E003DC5, 0x2AC12072,
    0x128E9DCF, 0x164F8078, 0x1B0CA6A1, 0x1FCDBB16, 0x018AEB13, 0x054BF6A4, 0x0808D07D, 0x0CC9CDCA,
    0x7897AB07, 0x7C56B6B0, 0x71159069, 0x75D48DDE, 0x6B93DDDB, 0x6F52C06C, 0x6211E6B5, 0x66D0FB02,
    0x5E9F46BF, 0x5A5E5B08, 0x571D7DD1, 0x53DC6066, 0x4D9B3063, 0x495A2DD4, 0x44190B0D, 0x40D816BA,
    0xACA5C697, 0xA864DB20, 0xA527FDF9, 0xA1E6E04E, 0xBFA1B04B, 0xBB60ADFC, 0xB6238B25, 0xB2E29692,
    0x8AAD2B2F, 0x8E6C3698, 0x832F1041, 0x87EE0DF6, 0x99A95DF3, 0x9D684044, 0x902B669D, 0x94EA7B2A,
    0xE0B41DE7, 0xE4750050, 0xE9362689, 0xEDF73B3E, 0xF3B06B3B, 0xF771768C, 0xFA325055, 0xFEF34DE2,
    0xC6BCF05F, 0xC27DEDE8, 0xCF3ECB31, 0xCBFFD686, 0xD5B88683, 0xD1799B34, 0xDC3ABDED, 0xD8FBA05A,
    0x690CE0EE, 0x6DCDFD59, 0x608EDB80, 0x644FC637, 0x7A089632, 0x7EC98B85, 0x738AAD5C, 0x774BB0EB,
    0x4F040D56, 0x4BC510E1, 0x46863638, 0x42472B8F, 0x5C007B8A, 0x58C1663D, 0x558240E4, 0x51435D53,
    0x251D3B9E, 0x21DC2629, 0x2C9F00F0, 0x285E1D47, 0x36194D42, 0x32D850F5, 0x3F9B762C, 0x3B5A6B9B,
    0x0315D626, 0x07D4CB91, 0x0A97ED48, 0x0E56F0FF, 0x1011A0FA, 0x14D0BD4D, 0x19939B94, 0x1D528623,
    0xF12F560E, 0xF5EE4BB9, 0xF8AD6D60, 0xFC6C70D7, 0xE22B20D2, 0xE6EA3D65, 0xEBA91BBC, 0xEF68060B,
    0xD727BBB6, 0xD3E6A601, 0xDEA580D8, 0xDA649D6F, 0xC423CD6A, 0xC0E2D0DD, 0xCDA1F604, 0xC960EBB3,
    0xBD3E8D7E, 0xB9FF90C9, 0xB4BCB610, 0xB07DABA7, 0xAE3AFBA2, 0xAAFBE615, 0xA7B8C0CC, 0xA379DD7B,
    0x9B3660C6, 0x9FF77D71, 0x92B45BA8, 0x9675461F, 0x8832161A, 0x8CF30BAD, 0x81B02D74, 0x857130C3,
    0x5D8A9099, 0x594B8D2E, 0x5408ABF7, 0x50C9B640, 0x4E8EE645, 0x4A4FFBF2, 0x470CDD2B, 0x43CDC09C,
    0x7B827D21, 0x7F436096, 0x7200464F, 0x76C15BF8, 0x68860BFD, 0x6C47164A, 0x61043093, 0x65C52D24,
    0x119B4BE9, 0x155A565E, 0x18197087, 0x1CD86D30, 0x029F3D35, 0x065E2082, 0x0B1D065B, 0x0FDC1BEC,
    0x3793A651, 0x3352BBE6, 0x3E119D3F, 0x3AD08088, 0x2497D08D, 0x2056CD3A, 0x2D15EBE3, 0x29D4F654,
    0xC5A92679, 0xC1683BCE, 0xCC2B1D17, 0xC8EA00A0, 0xD6AD50A5, 0xD26C4D12, 0xDF2F6BCB, 0xDBEE767C,
    0xE3A1CBC1, 0xE760D676, 0xEA23F0AF, 0xEEE2ED18, 0xF0A5BD1D, 0xF464A0AA, 0xF9278673, 0xFDE69BC4,
    0x89B8FD09, 0x8D79E0BE, 0x803AC667, 0x84FBDBD0, 0x9ABC8BD5, 0x9E7D9662, 0x933EB0BB, 0x97FFAD0C,
    0xAFB010B1, 0xAB710D06, 0xA6322BDF, 0xA2F33668, 0xBCB4666D, 0xB8757BDA, 0xB5365D03, 0xB1F740B4
];

function calcCRC32(buf: Buffer): number {
    let i = 0, l = buf.length, crc = -1;
    for (; i < l; i++) {
        crc = (crc << 8) ^ CRC32_TABLE[((crc >>> 24) ^ buf[i])];
    }
    return crc;
}

export = TSFilter;