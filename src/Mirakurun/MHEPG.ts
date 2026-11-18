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
import { getProgramItemId } from "./Program";
import * as apid from "../../api";
import _ from "./_";
import { EventState, EITVersion, SAMPLING_RATE, isOutOfDate as isOutOfDateTS, isOutOfDateLv2 as isOutOfDateLv2TS, getLangCode } from "./EPG";
import { MHContentDescriptorItem, MHExtendedEventItem } from "arib-mmt-tlv-ts/mmt-si-descriptor.js";
import { MHEventInformationTable, MMT_SI_TABLE_MH_EIT_PF } from "arib-mmt-tlv-ts/mmt-si.js";
import { bcdTimeToSeconds, mjdBCDToUnixEpoch, mjdToUnixEpoch } from "arib-mmt-tlv-ts/utils.js";

// MMT-SI times are in JST (UTC+9)
const JST_OFFSET_SECONDS = 3600 * 9;

const textDecoder = new TextDecoder();
function decodeUTF8(buffer: Uint8Array): string {
    return textDecoder.decode(buffer, { stream: false });
}

// ARIB STD-B60 Table 7-48 video_resolution (lines only; p/i resolved via videoScanFlag)
const VIDEO_RESOLUTION_LINES: Record<number, string> = {
    1: "180",
    2: "240",
    3: "480",
    4: "720",
    5: "1080",
    6: "2160",
    7: "4320"
};

function resolveVideoResolution(code: number, progressive: boolean): apid.ProgramVideoResolution | null {
    const lines = VIDEO_RESOLUTION_LINES[code];
    if (!lines) {
        return null;
    }
    return `${lines}${progressive ? "p" : "i"}` as apid.ProgramVideoResolution;
}

// ARIB STD-B60 Table 7-50 video_frame_rate
const VIDEO_FRAME_RATE: Record<number, apid.ProgramVideoFrameRate> = {
    1: "15",
    2: "23.976",
    3: "24",
    4: "25",
    5: "29.97",
    6: "30",
    7: "50",
    8: "59.94",
    9: "60",
    10: "100",
    11: "119.88",
    12: "120"
};

// ARIB STD-B60 Table 7-51 video_transfer_characteristics
const VIDEO_TRANSFER_CHARACTERISTICS: Record<number, apid.ProgramVideoTransferCharacteristics> = {
    1: "bt709",
    2: "iec61966",
    3: "bt2020",
    4: "bt2100-pq",
    5: "bt2100-hlg"
};

// forked from EPG.ts and MMirakurun (MHEPG)
export default class MHEPG {

    private _epg: { [networkId: number]: { [serviceId: number]: { [eventId: number]: EventState<MHExtendedEventItem> } } } = {};

    write(eit: MHEventInformationTable) {

        // 独立した取り込みでも、未適用の表を番組や版管理へ反映しない。
        if (!eit.currentNextIndicator) { return; }
        if (!this._epg) {
            return;
        }

        const isPF = eit.tableId === "EIT[p/f]";

        if (isPF && eit.sectionNumber > 1) {
            return;
        }

        const isP = isPF && eit.sectionNumber === 0;
        const isF = isPF && eit.sectionNumber === 1;

        const networkId = eit.originalNetworkId;

        if (!this._epg[networkId]) {
            this._epg[networkId] = {};
        }

        if (!this._epg[networkId][eit.serviceId]) {
            this._epg[networkId][eit.serviceId] = {};
        }

        const service = this._epg[networkId][eit.serviceId];

        for (const e of eit.events) {
            let state: EventState<MHExtendedEventItem>;

            if (!service[e.eventId]) {
                const id = getProgramItemId(networkId, eit.serviceId, e.eventId);
                const added = !_.program.exists(id);
                if (added) {
                    if (e.startTime === undefined) {
                        continue;
                    }
                    const programItem = {
                        id,
                        eventId: e.eventId,
                        serviceId: eit.serviceId,
                        networkId: networkId,
                        startAt: mjdBCDToUnixEpoch(e.startTime) * 1000,
                        duration: e.duration === undefined ? 1 : bcdTimeToSeconds(e.duration) * 1000,
                        isFree: !e.freeCAMode,
                        _pf: isPF || undefined, // for compatibility
                        _isPresent: isP || undefined,
                        _isFollowing: isF || undefined
                    };
                    _.program.add(programItem);
                }
                state = {
                    version: {},
                    programId: id,

                    short: { version: {} },
                    extended: { version: {} },
                    component: { version: {} },
                    content: { version: {} },
                    audio: { version: {}, _audios: {} },
                    series: { version: {} },
                    group: { version: {}, _groups: [] },

                    present: isP || undefined
                };

                // the schedule does not overwrite the program added by EIT[p/f] (as EPG.ts),
                // the program existing (stored, or collected before) is updated by EIT[p/f] or the table received next
                if (added) {
                    state.version[toVersion(eit).table_id] = eit.versionNumber;
                } else if (isPF && e.startTime !== undefined) {
                    state.version[toVersion(eit).table_id] = eit.versionNumber;
                    _.program.set(id, {
                        startAt: mjdBCDToUnixEpoch(e.startTime) * 1000,
                        duration: e.duration === undefined ? 1 : bcdTimeToSeconds(e.duration) * 1000,
                        isFree: !e.freeCAMode,
                        _pf: true, // for compatibility
                        _isPresent: isP || undefined,
                        _isFollowing: isF || undefined
                    });
                }
                service[e.eventId] = state;
            } else {
                state = service[e.eventId];

                if (!state.present && isP) {
                    state.present = true;
                }

                if ((!state.present || (state.present && isP)) && isOutOfDate(eit, state.version)) {
                    state.version[toVersion(eit).table_id] = eit.versionNumber;

                    if (e.startTime !== undefined) {
                        _.program.set(state.programId, {
                            startAt: mjdBCDToUnixEpoch(e.startTime) * 1000,
                            duration: e.duration === undefined ? 1 : bcdTimeToSeconds(e.duration) * 1000,
                            isFree: !e.freeCAMode,
                            _pf: isPF || undefined, // for compatibility
                            _isPresent: isP || undefined,
                            _isFollowing: isF || undefined
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
                        state.short.version[toVersion(eit).table_id] = eit.versionNumber;

                        _.program.set(state.programId, {
                            name: decodeUTF8(d.eventName),
                            description: decodeUTF8(d.text)
                        });

                        break;

                    case "mhExtendedEvent":
                        if (isOutOfDate(eit, state.extended.version)) {
                            state.extended.version[toVersion(eit).table_id] = eit.versionNumber;
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
                                extended: getExtended(state.extended._descs.flat())
                            });

                            delete state.extended._descs;
                            state.extended._done = true;
                        }

                        break;

                    case "videoComponent":
                        if (!isOutOfDate(eit, state.component.version)) {
                            break;
                        }
                        state.component.version[toVersion(eit).table_id] = eit.versionNumber;

                        _.program.set(state.programId, {
                            mmtVideo: {
                                resolution: resolveVideoResolution(d.videoResolution, !!d.videoScanFlag),
                                frameRate: VIDEO_FRAME_RATE[d.videoFrameRate] || undefined,
                                transferCharacteristics: VIDEO_TRANSFER_CHARACTERISTICS[d.videoTransferCharacteristics] || undefined
                            }
                        });

                        break;

                    case "mhContent":
                        if (!isOutOfDate(eit, state.content.version)) {
                            break;
                        }
                        state.content.version[toVersion(eit).table_id] = eit.versionNumber;

                        _.program.set(state.programId, {
                            genres: d.items.map(getGenre)
                        });

                        break;

                    case "mhAudioComponent":
                        if (!isOutOfDateLv2(eit, state.audio.version, d.componentTag)) {
                            break;
                        }
                        state.audio.version[toVersion(eit).table_id][d.componentTag] = eit.versionNumber;

                        const langs: apid.ProgramAudioLanguageCode[] = [
                            getLangCode(Buffer.from([
                                d.iso639LanguageCode >> 16,
                                d.iso639LanguageCode >> 8,
                                d.iso639LanguageCode
                            ]))
                        ];
                        if (d.esMultiLingualISO639LanguageCode !== undefined) {
                            langs.push(getLangCode(Buffer.from([
                                d.esMultiLingualISO639LanguageCode >> 16,
                                d.esMultiLingualISO639LanguageCode >> 8,
                                d.esMultiLingualISO639LanguageCode
                            ])));
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
                        state.series.version[toVersion(eit).table_id] = eit.versionNumber;

                        _.program.set(state.programId, {
                            series: {
                                id: d.seriesId,
                                repeat: d.repeatLabel,
                                pattern: d.programPattern,
                                // expire_date is plain MJD (not MJD+BCD), at 00:00 JST
                                expiresAt: d.expireDateValidFlag ?
                                    (mjdToUnixEpoch(d.expireDate) - JST_OFFSET_SECONDS) * 1000 :
                                    -1,
                                episode: d.episodeNumber,
                                lastEpisode: d.lastEpisodeNumber,
                                name: decodeUTF8(d.seriesName)
                            }
                        });

                        break;

                    case "mhEventGroup": {
                        if (!isOutOfDateLv2(eit, state.group.version, d.groupType)) {
                            break;
                        }
                        state.group.version[toVersion(eit).table_id][d.groupType] = eit.versionNumber;

                        const relType: apid.ProgramRelatedItem["type"] =
                            d.groupType === 1 ? "shared" :
                                (d.groupType === 2 || d.groupType === 4) ? "relay" : "movement";

                        const relItems: apid.ProgramRelatedItem[] = d.events.map(event => ({
                            type: relType,
                            networkId: eit.originalNetworkId,
                            serviceId: event.serviceId,
                            eventId: event.eventId
                        }));

                        // groupType 4/5 have otherNetworkEvents with originalNetworkId
                        if ("otherNetworkEvents" in d) {
                            for (const other of d.otherNetworkEvents) {
                                relItems.push({
                                    type: relType,
                                    networkId: other.originalNetworkId,
                                    serviceId: other.serviceId,
                                    eventId: other.eventId
                                });
                            }
                        }

                        state.group._groups[d.groupType] = relItems;

                        _.program.set(state.programId, {
                            relatedItems: state.group._groups.flat()
                        });

                        break;
                    }
                }
            }
        }
    }

    end() {
        if (this._epg) {
            delete this._epg;
        }
    }
}

/** EIT[p/f] of MH-EIT is treated as EIT[p/f actual] (0x4E) of TS */
function toVersion(eit: MHEventInformationTable): EITVersion {
    return {
        table_id: eit.tableIdNumber === MMT_SI_TABLE_MH_EIT_PF ? 0x4E : eit.tableIdNumber,
        version_number: eit.versionNumber
    };
}

function isOutOfDate(eit: MHEventInformationTable, versionRecord: Record<number, number>): boolean {
    return isOutOfDateTS(toVersion(eit), versionRecord);
}

function isOutOfDateLv2(eit: MHEventInformationTable, versionRecord: Record<number, Record<number, number>>, lv2: number): boolean {
    return isOutOfDateLv2TS(toVersion(eit), versionRecord, lv2);
}

/** the items continued from the previous one have an empty item_description (ARIB STD-B10) */
function getExtended(items: MHExtendedEventItem[]): { [description: string]: string } {
    const merged: { description: Uint8Array, item: Buffer[] }[] = [];
    for (const item of items) {
        if (item.itemDescription.length === 0 && merged.length > 0) {
            merged[merged.length - 1].item.push(Buffer.from(item.item));
        } else {
            merged.push({ description: item.itemDescription, item: [Buffer.from(item.item)] });
        }
    }
    return Object.fromEntries(merged.map(x => [decodeUTF8(x.description), decodeUTF8(Buffer.concat(x.item))]));
}

function getGenre(content: MHContentDescriptorItem): apid.ProgramGenre {
    return {
        lv1: content.contentNibbleLevel1,
        lv2: content.contentNibbleLevel2,
        un1: content.userNibble >> 4,
        un2: content.userNibble & 0xf
    };
}
