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
import * as db from "./db";
import queue from "./queue";
import Program from "./Program";
const getProgramId = Program.getProgramId;
import ProgramItem from "./ProgramItem";
import * as aribts from "aribts";
const TsChar = aribts.TsChar;
const TsDate = aribts.TsDate;

const STREAM_CONTENT = {
    1: "mpeg2",
    5: "h.264",
    9: "h.265"
};

const COMPONENT_TYPE = {
    0x01: "480i",
    0x02: "480i",
    0x03: "480i",
    0x04: "480i",
    0x83: "4320p",
    0x91: "2160p",
    0x92: "2160p",
    0x93: "2160p",
    0x94: "2160p",
    0xA1: "480p",
    0xA2: "480p",
    0xA3: "480p",
    0xA4: "480p",
    0xB1: "1080i",
    0xB2: "1080i",
    0xB3: "1080i",
    0xB4: "1080i",
    0xC1: "720p",
    0xC2: "720p",
    0xC3: "720p",
    0xC4: "720p",
    0xD1: "240p",
    0xD2: "240p",
    0xD3: "240p",
    0xD4: "240p",
    0xE1: "1080p",
    0xE2: "1080p",
    0xE3: "1080p",
    0xE4: "1080p",
    0xF1: "180p",
    0xF2: "180p",
    0xF3: "180p",
    0xF4: "180p"
};

const SAMPLING_RATE = {
    0: -1,
    1: 16000,
    2: 22050,
    3: 24000,
    4: -1,
    5: 32000,
    6: 44100,
    7: 48000
};

interface EventState {
    version: VersionState;
    program: ProgramItem;

    short: {
        version: number; // basic
        event_name_char: Buffer;
        text_char: Buffer;
    };
    extended: {
        version: number; // extended
        _descs: {
            item_description_length: number;
            item_description_char: Buffer;
            item_length: number;
            item_char: Buffer;
        }[][];
        _done: boolean;
    };
    component: {
        version: number; // basic
        stream_content: number;
        component_type: number;
    };
    content: {
        version: number; // basic
        _raw: Buffer;
    };
    audio: {
        version: number; // basic
        _raw: Buffer;
    };
    series: {
        version: number; // basic
        _raw: Buffer;
    };
    group: {
        version: number; // basic
        _raw: Buffer;
    };
}

interface VersionState {
    basic: number;
    extended: number;
}

// forked from rndomhack/node-aribts/blob/1e7ef94bba3d6ac26aec764bf24dde2c2852bfcb/lib/epg.js
class EPG extends stream.Writable {

    private _epg: { [networkId: number]: { [serviceId: number]: { [eventId: number]: EventState } } } = {};
    private _epgGCInterval: number = 1000 * 60 * 15;

    constructor() {
        super({
            objectMode: true
        });

        setTimeout(this._gc.bind(this), this._epgGCInterval);
    }

    _write(eit: any, encoding: string, callback: Function) {

        const networkId = eit.original_network_id;

        if (typeof this._epg[networkId] === "undefined") {
            this._epg[networkId] = {};
        }

        if (typeof this._epg[networkId][eit.service_id] === "undefined") {
            this._epg[networkId][eit.service_id] = {};
        }

        const service = this._epg[networkId][eit.service_id];

        const l = eit.events.length;
        for (let i = 0; i < l; i++) {
            const e = eit.events[i];
            let state: EventState;

            if (typeof service[e.event_id] === "undefined") {
                state = {
                    version: {
                        basic: isBasicTable(eit.table_id) ? eit.version_number : -1,
                        extended: isBasicTable(eit.table_id) ? -1 : eit.version_number
                    },
                    program: new ProgramItem({
                        id: getProgramId(networkId, eit.service_id, e.event_id),

                        eventId: e.event_id,
                        serviceId: eit.service_id,
                        networkId: networkId,
                        startAt: getTime(e.start_time),
                        duration: getTimeFromBCD24(e.duration),
                        isFree: e.free_CA_mode === 0
                    }),

                    short: {
                        version: -1,
                        event_name_char: null,
                        text_char: null
                    },
                    extended: {
                        version: -1,
                        _descs: null,
                        _done: true
                    },
                    component: {
                        version: -1,
                        stream_content: -1,
                        component_type: -1
                    },
                    content: {
                        version: -1,
                        _raw: null
                    },
                    audio: {
                        version: -1,
                        _raw: null
                    },
                    series: {
                        version: -1,
                        _raw: null
                    },
                    group: {
                        version: -1,
                        _raw: null
                    }
                };

                service[e.event_id] = state;
            } else {
                state = service[e.event_id];

                if (isOutOfDate(state, eit) === true) {
                    if (isBasicTable(eit.table_id) === true) {
                        state.version.basic = eit.version_number;
                    } else {
                        state.version.extended = eit.version_number;
                    }

                    state.program.update({
                        startAt: getTime(e.start_time),
                        duration: getTimeFromBCD24(e.duration),
                        isFree: e.free_CA_mode === 0
                    });
                }
            }

            const m = e.descriptors.length;
            for (let j = 0; j < m; j++) {
                const d = e.descriptors[j];

                switch (d.descriptor_tag) {
                    // short_event
                    case 0x4D:
                        if (state.short.version === eit.version_number) {
                            break;
                        }
                        state.short.version = eit.version_number;

                        if (
                            state.short.event_name_char !== null &&
                            state.short.text_char !== null &&
                            state.short.event_name_char.compare(d.event_name_char) === 0 &&
                            state.short.text_char.compare(d.text_char) === 0
                        ) {
                            break;
                        }

                        state.short.event_name_char = d.event_name_char;
                        state.short.text_char = d.text_char;

                        state.program.update({
                            name: new TsChar(d.event_name_char).decode(),
                            description: new TsChar(d.text_char).decode()
                        });

                        break;

                    // extended_event
                    case 0x4E:
                        if (state.extended.version !== eit.version_number) {
                            state.extended.version = eit.version_number;
                            state.extended._descs = new Array(d.last_descriptor_number + 1);
                            state.extended._done = false;
                        } else if (state.extended._done === true) {
                            break;
                        }

                        if (state.extended._descs[d.descriptor_number] === undefined) {
                            state.extended._descs[d.descriptor_number] = d.items;

                            {
                                let comp = true;
                                const l = state.extended._descs.length;
                                for (let i = 0; i < l; i++) {
                                    if (state.extended._descs[i] === undefined) {
                                        comp = false;
                                        break;
                                    }
                                }
                                if (comp === false) {
                                    break;
                                }
                            }

                            const extended: any = {};

                            {
                                let current = "";
                                const l = state.extended._descs.length;
                                for (let i = 0; i < l; i++) {
                                    const m = state.extended._descs[i].length;
                                    for (let j = 0; j < m; j++) {
                                        const desc = state.extended._descs[i][j].item_description_length === 0
                                                    ? current
                                                    : new TsChar(state.extended._descs[i][j].item_description_char).decode();
                                        current = desc;

                                        const char = new TsChar(state.extended._descs[i][j].item_char).decode();
                                        if (extended[desc] === undefined) {
                                            extended[desc] = char;
                                        } else {
                                            extended[desc] += char;
                                        }
                                    }
                                    state.extended._descs[i] = null; // clean up
                                }
                            }

                            state.program.update({
                                extended: extended
                            });

                            state.extended._done = true; // done
                        }

                        break;

                    // component
                    case 0x50:
                        if (state.component.version === eit.version_number) {
                            break;
                        }
                        state.component.version = eit.version_number;

                        if (
                            state.component.stream_content === d.stream_content &&
                            state.component.component_type === d.component_type
                        ) {
                            break;
                        }

                        state.component.stream_content = d.stream_content;
                        state.component.component_type = d.component_type;

                        state.program.update({
                            video: {
                                type: <db.ProgramVideoType> STREAM_CONTENT[d.stream_content] || null,
                                resolution: <db.ProgramVideoResolution> COMPONENT_TYPE[d.component_type] || null,

                                streamContent: d.stream_content,
                                componentType: d.component_type
                            }
                        });

                        break;

                    // content
                    case 0x54:
                        if (state.content.version === eit.version_number) {
                            break;
                        }
                        state.content.version = eit.version_number;

                        if (
                            state.content._raw !== null &&
                            state.content._raw.compare(d._raw) === 0
                        ) {
                            break;
                        }

                        state.content._raw = d._raw;

                        state.program.update({
                            genres: d.contents.map(getGenre)
                        });

                        break;

                    // audio component
                    case 0xC4:
                        if (state.audio.version === eit.version_number) {
                            break;
                        }
                        state.audio.version = eit.version_number;

                        if (
                            state.audio._raw !== null &&
                            state.audio._raw.compare(d._raw) === 0
                        ) {
                            break;
                        }

                        state.audio._raw = d._raw;

                        state.program.update({
                            audio: {
                                samplingRate: SAMPLING_RATE[d.sampling_rate],
                                componentType: d.component_type
                            }
                        });

                        break;

                    // series
                    case 0xD5:
                        if (state.series.version === eit.version_number) {
                            break;
                        }
                        state.series.version = eit.version_number;

                        if (
                            state.series._raw !== null &&
                            state.series._raw.compare(d._raw) === 0
                        ) {
                            break;
                        }

                        state.series._raw = d._raw;

                        state.program.update({
                            series: {
                                id: d.series_id,
                                repeat: d.repeat_label,
                                pattern: d.program_pattern,
                                expiresAt: d.expire_date_valid_flag === 1 ?
                                    getTime(Buffer.from(d.expire_date.toString(16), "hex")) :
                                    -1,
                                episode: d.episode_number,
                                lastEpisode: d.last_episode_number,
                                name: new TsChar(d.series_name_char).decode()
                            }
                        });

                        break;

                    // event_group
                    case 0xD6:
                        if (state.group.version === eit.version_number) {
                            break;
                        }
                        state.group.version = eit.version_number;

                        if (
                            state.group._raw !== null &&
                            state.group._raw.compare(d._raw) === 0
                        ) {
                            break;
                        }

                        state.group._raw = d._raw;

                        if (typeof d.other_network_events === "undefined") {
                            state.program.update({
                                relatedItems: d.events.map(getRelatedProgramItem)
                            });
                        } else {
                            state.program.update({
                                relatedItems: [
                                    ...d.events.map(getRelatedProgramItem),
                                    ...d.other_network_events.map(getRelatedProgramItem)
                                ]
                            });
                        }

                        break;
                }// <- switch
            }// <- for
        }// <- for

        callback();
    }

    private _gc(): void {

        log.info("EPG GC has queued");

        queue.add(async () => {

            const now = Date.now();
            let count = 0;

            for (const nid in this._epg) {
                for (const sid in this._epg[nid]) {
                    for (const eid in this._epg[nid][sid]) {
                        const state = this._epg[nid][sid][eid];
                        if (now > (state.program.data.startAt + state.program.data.duration)) {
                            ++count;
                            delete state.program;
                            delete this._epg[nid][sid][eid];
                        }
                    }
                }
            }

            setTimeout(this._gc.bind(this), this._epgGCInterval);

            log.info("EPG GC has finished and removed %d events", count);
        });
    }
}

function isBasicTable(tableId: number): boolean {

    if (tableId < 0x60) {
        if (tableId < 0x58) {
            return true;
        } else {
            return false;
        }
    } else {
        if (tableId < 0x68) {
            return true;
        } else {
            return false;
        }
    }
}

function isOutOfDate(state: EventState, eit: any): boolean {

    if (isBasicTable(eit.table_id) === true) {
        if (state.version.basic === eit.version_number) {
            return false;
        }
    } else {
        if (state.version.extended === eit.version_number) {
            return false;
        }
    }

    return true;
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

function getTimeFromBCD24(buffer: Buffer): number {

    let time = ((buffer[0] >> 4) * 10 + (buffer[0] & 0x0F)) * 3600;
    time += ((buffer[1] >> 4) * 10 + (buffer[1] & 0x0F)) * 60;
    time += (buffer[2] >> 4) * 10 + (buffer[2] & 0x0F);

    return time * 1000;
}

function getGenre(content: any): db.ProgramGenre {
    return {
        lv1: content.content_nibble_level_1,
        lv2: content.content_nibble_level_2,
        un1: content.user_nibble_1,
        un2: content.user_nibble_2
    };
}

function getRelatedProgramItem(event: any): db.ProgramRelatedItem {
    return {
        networkId: event.original_network_id,
        serviceId: event.service_id,
        eventId: event.event_id
    };
}

export default new EPG();
