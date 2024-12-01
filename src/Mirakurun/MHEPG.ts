/*
   Copyright 2016 kanreisa
   Copyright 2024 otya

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
import { getProgramItemId } from "./Program";
import * as db from "./db";
import _ from "./_";
import { MHContentDescriptorItem, MHExtendedEventItem } from "arib-mmt-tlv-ts/mmt-si-descriptor.js";
import {  MHEventInformationTable, MMT_SI_TABLE_MH_EIT_PF } from "arib-mmt-tlv-ts/mmt-si.js";
import { bcdTimeToSeconds, mjdBCDToUnixEpoch } from "arib-mmt-tlv-ts/utils.js";
import { decodeUTF8 } from "./common";

const VIDEO_RESOLUTION = {
    5: "1080p",
    6: "2160p",
    7: "4320p"
};

const SAMPLING_RATE = {
    7: 48000
};

const ISO_639_LANG_CODE = {
    jpn: Buffer.from("6A706E", "hex"),
    eng: Buffer.from("656E67", "hex"),
    deu: Buffer.from("646575", "hex"),
    fra: Buffer.from("667261", "hex"),
    ita: Buffer.from("697461", "hex"),
    rus: Buffer.from("727573", "hex"),
    zho: Buffer.from("7A686F", "hex"),
    kor: Buffer.from("6B6F72", "hex"),
    spa: Buffer.from("737061", "hex"),
    etc: Buffer.from("657463", "hex")
};

type TableId = number;
type VersionRecord<T = number> = Record<TableId, T>;

interface EventState {
    version: VersionRecord;
    programId: number;

    short: {
        version: VersionRecord; // basic
    };
    extended: {
        version: VersionRecord; // extended
        _descs?: MHExtendedEventItem[][];
        _done?: boolean;
    };
    component: {
        version: VersionRecord; // basic
    };
    content: {
        version: VersionRecord; // basic
    };
    audio: {
        version: VersionRecord<VersionRecord>; // basic
        _audios: { [componentTag: number]: db.ProgramAudio };
    };
    series: {
        version: VersionRecord; // basic
    };
    group: {
        version: VersionRecord<VersionRecord>; // basic
        _groups: db.ProgramRelatedItem[][];
    };

    present?: true;
}

// forked from rndomhack/node-aribts/blob/1e7ef94bba3d6ac26aec764bf24dde2c2852bfcb/lib/epg.js
export default class EPG {

    private _epg: { [networkId: number]: { [serviceId: number]: { [eventId: number]: EventState } } } = {};

    write(eit: MHEventInformationTable) {

        if (!this._epg) {
            return;
        }

        const isPF = eit.tableId === "EIT[p/f]";

        if (isPF && eit.sectionNumber > 1) {
            return;
        }

        const isP = isPF && eit.sectionNumber === 0;

        const networkId = eit.originalNetworkId;

        if (!this._epg[networkId]) {
            this._epg[networkId] = {};
        }

        if (!this._epg[networkId][eit.serviceId]) {
            this._epg[networkId][eit.serviceId] = {};
        }

        const service = this._epg[networkId][eit.serviceId];

        for (const e of eit.events) {
            let state: EventState;

            if (!service[e.eventId]) {
                const id = getProgramItemId(networkId, eit.serviceId, e.eventId);
                if (!_.program.exists(id)) {
                    if (e.startTime == null) {
                        continue;
                    }
                    const programItem = {
                        id,
                        eventId: e.eventId,
                        serviceId: eit.serviceId,
                        networkId: networkId,
                        startAt: mjdBCDToUnixEpoch(e.startTime) * 1000,
                        duration: e.duration == null ? 1 : bcdTimeToSeconds(e.duration) * 1000,
                        isFree: !e.freeCAMode,
                        _pf: isPF || undefined
                    };
                    _.program.add(programItem);
                }

                state = {
                    version: {},
                    programId: id,

                    short: {
                        version: {}
                    },
                    extended: {
                        version: {}
                    },
                    component: {
                        version: {}
                    },
                    content: {
                        version: {}
                    },
                    audio: {
                        version: {},
                        _audios: {}
                    },
                    series: {
                        version: {}
                    },
                    group: {
                        version: {},
                        _groups: []
                    },

                    present: isP || undefined
                };

                service[e.eventId] = state;
            } else {
                state = service[e.eventId];

                if (!state.present && isP) {
                    state.present = true;
                }

                if ((!state.present || (state.present && isP)) && isOutOfDate(eit, state.version)) {
                    state.version[eit.tableIdNumber] = eit.versionNumber;

                    if (e.startTime != null) {
                        _.program.set(state.programId, {
                            startAt: mjdBCDToUnixEpoch(e.startTime) * 1000,
                            duration: e.duration == null ? 1 : bcdTimeToSeconds(e.duration) * 1000,
                            isFree: !e.freeCAMode,
                            _pf: isPF || undefined
                        });
                    }
                }
            }

            for (const d of e.descriptors) {
                switch (d.tag) {
                    case "mhShortEvent":
                        if (!isOutOfDate(eit, state.short.version)) {
                            break;
                        }
                        state.short.version[eit.tableIdNumber] = eit.versionNumber;

                        _.program.set(state.programId, {
                            name: decodeUTF8(d.eventName),
                            description: decodeUTF8(d.text)
                        });

                        break;

                    case "mhExtendedEvent":
                        if (isOutOfDate(eit, state.extended.version)) {
                            state.extended.version[eit.tableIdNumber] = eit.versionNumber;
                            state.extended._descs = new Array(d.lastDescriptorNumber + 1);
                            state.extended._done = false;
                        } else if (state.extended._done) {
                            break;
                        }

                        if (!state.extended._descs[d.descriptorNumber]) {
                            state.extended._descs[d.descriptorNumber] = d.items;

                            let comp = true;
                            for (const descs of state.extended._descs) {
                                if (typeof descs === "undefined") {
                                    comp = false;
                                    break;
                                }
                            }
                            if (comp === false) {
                                break;
                            }

                            _.program.set(state.programId, {
                                extended: Object.fromEntries(state.extended._descs.flat().map(x => [decodeUTF8(x.itemDescription), decodeUTF8(x.item)]))
                            });

                            delete state.extended._descs;
                            state.extended._done = true; // done
                        }

                        break;

                    case "videoComponent":
                        if (!isOutOfDate(eit, state.component.version)) {
                            break;
                        }
                        state.component.version[eit.tableIdNumber] = eit.versionNumber;

                        _.program.set(state.programId, {
                            video: {
                                type: null,
                                resolution: <db.ProgramVideoResolution> VIDEO_RESOLUTION[d.videoResolution] || null,
                                streamContent: null,
                                componentType: null
                            }
                        });

                        break;

                    case "mhContent":
                        if (!isOutOfDate(eit, state.content.version)) {
                            break;
                        }
                        state.content.version[eit.tableIdNumber] = eit.versionNumber;

                        _.program.set(state.programId, {
                            genres: d.items.map(getGenre)
                        });

                        break;

                    case "mhAudioComponent":
                        if (!isOutOfDateLv2(eit, state.audio.version, d.componentTag)) {
                            break;
                        }
                        state.audio.version[eit.tableIdNumber][d.componentTag] = eit.versionNumber;

                        const langs = [getLangCode(Buffer.from([d.iso639LanguageCode >> 16, d.iso639LanguageCode >> 8, d.iso639LanguageCode]))];
                        if (d.esMultiLingualISO639LanguageCode != null) {
                            langs.push(getLangCode(Buffer.from([d.esMultiLingualISO639LanguageCode >> 16, d.esMultiLingualISO639LanguageCode >> 8, d.esMultiLingualISO639LanguageCode])));
                        }

                        state.audio._audios[d.componentTag] = {
                            componentType: d.componentType,
                            componentTag: d.componentTag,
                            isMain: d.mainComponentFlag,
                            samplingRate: SAMPLING_RATE[d.samplingRate],
                            langs
                        };

                        _.program.set(state.programId, {
                            audios: Object.values(state.audio._audios)
                        });

                        break;

                    case "mhSeries":
                        if (!isOutOfDate(eit, state.series.version)) {
                            break;
                        }
                        state.series.version[eit.tableIdNumber] = eit.versionNumber;

                        _.program.set(state.programId, {
                            series: {
                                id: d.seriesId,
                                repeat: d.repeatLabel,
                                pattern: d.programPattern,
                                expiresAt: d.expireDate != null ?
                                    mjdBCDToUnixEpoch(d.expireDate) * 1000 :
                                    -1,
                                episode: d.episodeNumber,
                                lastEpisode: d.lastEpisodeNumber,
                                name: decodeUTF8(d.seriesName)
                            }
                        });

                        break;

                    // event_group
                    case "mhEventGroup":
                        if (!isOutOfDateLv2(eit, state.group.version, d.groupType)) {
                            break;
                        }
                        state.group.version[eit.tableIdNumber][d.groupType] = eit.versionNumber;

                        state.group._groups[d.groupType] = d.events.map(getRelatedProgramItem.bind(d));

                        _.program.set(state.programId, {
                            relatedItems: state.group._groups.flat()
                        });

                        break;
                } // <- switch
            } // <- for
        } // <- for
    }

    end() {
        if (this._epg) {
            delete this._epg;
        }
    }
}

function isOutOfDate(eit: MHEventInformationTable, versionRecord: VersionRecord): boolean {

    if (versionRecord[MMT_SI_TABLE_MH_EIT_PF] !== undefined && eit.tableIdNumber !== MMT_SI_TABLE_MH_EIT_PF) {
        return false;
    }

    return versionRecord[eit.tableIdNumber] !== eit.versionNumber;
}

function isOutOfDateLv2(eit: MHEventInformationTable, versionRecord: VersionRecord<VersionRecord>, lv2: number): boolean {

    if (versionRecord[MMT_SI_TABLE_MH_EIT_PF] !== undefined && eit.tableIdNumber !== MMT_SI_TABLE_MH_EIT_PF) {
        return false;
    }
    if (versionRecord[eit.tableIdNumber] === undefined) {
        versionRecord[eit.tableIdNumber] = {};
    }

    return versionRecord[eit.tableIdNumber][lv2] !== eit.versionNumber;
}

function getGenre(content: MHContentDescriptorItem): db.ProgramGenre {
    return {
        lv1: content.contentNibbleLevel1,
        lv2: content.contentNibbleLevel2,
        un1: content.userNibble >> 4,
        un2: content.userNibble & 0xf
    };
}

function getLangCode(buffer: Buffer): db.ProgramAudioLanguageCode {
    for (const code in ISO_639_LANG_CODE) {
        if (ISO_639_LANG_CODE[code].compare(buffer) === 0) {
            return code as db.ProgramAudioLanguageCode;
        }
    }
    return "etc";
}

function getRelatedProgramItem(event: any): db.ProgramRelatedItem {
    return {
        type: (
            this.group_type === 1 ? "shared" :
                (this.group_type === 2 || this.group_type === 4) ? "relay" : "movement"
        ),
        networkId: event.original_network_id,
        serviceId: event.serviceId,
        eventId: event.eventId
    };
}
