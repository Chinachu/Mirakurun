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

/** a section of EIT[schedule] (EIT of TS and MH-EIT of MMT) */
export interface EITScheduleSection {
    networkId: number;
    serviceId: number;
    versionNumber: number;
    isBasic: boolean;
    /** table_id & 0x07 */
    flagsId: number;
    /** last_table_id & 0x07 */
    lastFlagsId: number;
    sectionNumber: number;
    lastSectionNumber: number;
    segmentLastSectionNumber: number;
}

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

/** tracks the sections of EIT[schedule] received to know when all of them have been received */
export default class EPGState {
    private _state: { [networkId: number]: { [serviceId: number]: BasicExtState } } = {};

    /**
     * @param streamTime the time of the stream (TOT), `null` if not received yet
     * @returns `true` if all the sections have been received
     */
    update(data: EITScheduleSection, streamTime: number | null): boolean {
        const networkId = data.networkId;
        const serviceId = data.serviceId;
        const versionNumber = data.versionNumber;

        const stateByNet = this._state[networkId] || (this._state[networkId] = {});
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
                        flag: Buffer.allocUnsafeSlow(32).fill(0x00),
                        ignore: Buffer.allocUnsafeSlow(32).fill(0xFF),
                        version_number: -1
                    });
                }
            }
        }

        const flagsId = data.flagsId;
        const lastFlagsId = data.lastFlagsId;
        const segmentNumber = data.sectionNumber >> 3;
        const lastSegmentNumber = data.lastSectionNumber >> 3;
        const sectionNumber = data.sectionNumber & 0x07;
        const segmentLastSectionNumber = data.segmentLastSectionNumber & 0x07;
        const targetFlags = data.isBasic ? stateBySrv.basic : stateBySrv.extended;
        const targetFlag = targetFlags.flags[flagsId];

        if ((targetFlags.lastFlagsId !== lastFlagsId) ||
            (targetFlag.version_number !== -1 && targetFlag.version_number !== versionNumber)) {
            // version check
            if (targetFlag.version_number !== -1) {
                const verDiff = versionNumber - targetFlag.version_number;
                if (verDiff === -1 || verDiff > 1) {
                    return false;
                }
            }
            // reset fields
            for (let i = 0; i < 0x08; i++) {
                targetFlags.flags[i].flag.fill(0x00);
                targetFlags.flags[i].ignore.fill(i <= lastFlagsId ? 0x00 : 0xFF);
            }
        }

        // update ignore field (past segment)
        if (flagsId === 0 && streamTime !== null) {
            const segment = (streamTime + 9 * 60 * 60 * 1000) / (3 * 60 * 60 * 1000) & 0x07;

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

        for (const nid in this._state) {
            for (const sid in this._state[nid]) {
                for (const table of this._state[nid][sid].basic.flags.concat(this._state[nid][sid].extended.flags)) {
                    for (let i = 0; i < table.flag.length; i++) {
                        if ((table.flag[i] | table.ignore[i]) !== 0xFF) {
                            return false;
                        }
                    }
                }
            }
        }

        return true;
    }

    clear(): void {
        this._state = {};
    }
}
