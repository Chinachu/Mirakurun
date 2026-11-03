/*
   Copyright 2026 kanreisa

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

// 衛星の選局で dvbv5-zap (libdvbv5 1.22) と同じ動作をするための LNBf と DiSEqC の処理
// (LNBf による周波数の変換、LNB への給電、22kHz トーン、DiSEqC)
//
// 出典: v4l-utils (https://git.linuxtv.org/v4l-utils.git) の lib/libdvbv5/dvb-sat.c
// LNBf の周波数の表と、周波数の変換と LNB の操作の手順を参考に、TypeScript で書き直した。

import { SEC_MINI, SEC_VOLTAGE, SYS } from "./constants";

/** 偏波 (チャンネル設定の POLARIZATION。libdvbv5 の `enum dvb_sat_polarization`) */
export const POLARIZATION = {
    OFF: 0,
    H: 1,
    V: 2,
    L: 3,
    R: 4
} as const;

/** チャンネル設定の POLARIZATION の値 */
export const POLARIZATION_NAMES: { readonly [name: string]: number } = {
    OFF: POLARIZATION.OFF,
    HORIZONTAL: POLARIZATION.H,
    VERTICAL: POLARIZATION.V,
    LEFT: POLARIZATION.L,
    RIGHT: POLARIZATION.R
};

/** 周波数の範囲 (MHz)。rangeswitch はこの周波数を超えると次の範囲 (高い方のバンド) を使う */
interface LnbFreqRange {
    readonly low: number;
    readonly high: number;
    readonly lo: number;
    readonly rangeswitch: number;
    readonly pol: number;
}

export interface Lnb {
    readonly alias: string;
    readonly freqRanges: readonly LnbFreqRange[];
}

function range(low: number, high: number, lo: number, rangeswitch = 0, pol: number = POLARIZATION.OFF): LnbFreqRange {
    return { low, high, lo, rangeswitch, pol };
}

const { H, V, L, R } = POLARIZATION;

// dvbv5-zap の `-l` で指定できる LNBf (libdvbv5 と同じ順。別名が重複する場合は先のものを使う)
const LNBS: readonly Lnb[] = [
    { alias: "EXTENDED", freqRanges: [range(10700, 11700, 9750, 11700), range(11700, 12750, 10600)] },
    { alias: "UNIVERSAL", freqRanges: [range(10800, 11800, 9750, 11700), range(11600, 12700, 10600)] },
    { alias: "DBS", freqRanges: [range(12200, 12700, 11250)] },
    { alias: "STANDARD", freqRanges: [range(10945, 11450, 10000)] },
    { alias: "L10700", freqRanges: [range(11750, 12750, 10700)] },
    { alias: "L10750", freqRanges: [range(11700, 12200, 10750)] },
    { alias: "L11300", freqRanges: [range(12250, 12750, 11300)] },
    { alias: "ENHANCED", freqRanges: [range(10700, 11700, 9750)] },
    { alias: "QPH031", freqRanges: [range(11700, 12200, 10750, 12200), range(12200, 12700, 11250)] },
    { alias: "C-BAND", freqRanges: [range(3700, 4200, 5150)] },
    { alias: "C-MULT", freqRanges: [range(3700, 4200, 5150, 0, R), range(3700, 4200, 5750, 0, L)] },
    { alias: "DISHPRO", freqRanges: [range(12200, 12700, 11250, 0, V), range(12200, 12700, 14350, 0, H)] },
    { alias: "110BS", freqRanges: [range(11710, 12751, 10678)] },
    { alias: "STACKED-BRASILSAT", freqRanges: [range(10700, 11700, 9710, 0, H), range(10700, 11700, 9750, 0, H)] },
    { alias: "OI-BRASILSAT", freqRanges: [range(10950, 11200, 10000, 11700), range(11800, 12200, 10445)] },
    { alias: "AMAZONAS", freqRanges: [range(11037, 11450, 9670, 0, V), range(11770, 12070, 9922, 0, H), range(10950, 11280, 10000, 0, H)] },
    { alias: "AMAZONAS", freqRanges: [range(11037, 11360, 9670, 0, V), range(11780, 12150, 10000, 0, H), range(10950, 11280, 10000, 0, H)] },
    // 小数点以下は libdvbv5 で整数に切り捨てられる
    { alias: "GVT-BRASILSAT", freqRanges: [range(11010, 11067, 12860, 0, V), range(11704, 11941, 13435, 0, V), range(10962, 11199, 13112, 0, H), range(11704, 12188, 13138, 0, H)] }
];

/** LNBf を別名で探す (大文字と小文字を区別しない) */
export function findLnb(alias: string): Lnb | null {
    const upper = alias.toUpperCase();
    return LNBS.find(lnb => lnb.alias === upper) || null;
}

export interface SatOptions {
    /** LNBf (dvbv5-zap の `-l` またはチャンネル設定の LNB)。null の場合は LNB を操作せず、周波数もそのまま使う */
    readonly lnb: Lnb | null;
    /** 衛星の番号 (`-S`)。負の場合は DiSEqC を使わない */
    readonly satNumber: number;
    /** DiSEqC のコマンドの後に追加で待つ時間 (`-W`, ミリ秒) */
    readonly diseqcWait: number;
    /** SCR/Unicable のバンドパスフィルターの周波数 (`-U`, kHz)。0 の場合は使わない */
    readonly freqBpf: number;
}

export interface SecCommands {
    /** `SEC_VOLTAGE.V13` または `SEC_VOLTAGE.V18` */
    readonly voltage: number;
    readonly tone: boolean;
    /** DiSEqC (衛星の番号がある場合) */
    readonly diseqc: {
        readonly command: readonly number[];
        /** mini-DiSEqC (`SEC_MINI.*`)。衛星の番号が 2 以上の場合は null */
        readonly burst: number | null;
        readonly wait: number;
    } | null;
}

export interface SatTuning {
    /** frontend に設定する周波数 (kHz) */
    readonly frequency: number;
    /** LNB の操作。SCR/Unicable で DiSEqC を使わない場合は null */
    readonly sec: SecCommands | null;
}

/**
 * 衛星の選局で frontend に設定する周波数と LNB の操作を返す。
 * LNBf がない場合や、周波数が LNBf の範囲外の場合は null (dvbv5-zap と同じく、周波数をそのまま使い LNB を操作しない)。
 *
 * @param frequency チャンネル設定の周波数 (kHz)
 */
export function getSatTuning(deliverySystem: number, frequency: number, polarization: number, options: SatOptions): SatTuning | null {
    const { lnb } = options;
    if (lnb === null || frequency === 0) {
        return null;
    }
    const ranges = lnb.freqRanges;
    const inRange = (r: LnbFreqRange) => frequency >= r.low * 1000 && frequency <= r.high * 1000;

    let highBand = false;
    let offset: number;
    let scr = 0;
    if (ranges.length === 1) {
        // 局部発振器が 1 つの LNBf は範囲を確かめない
        offset = ranges[0].lo * 1000;
    } else if (ranges[0].pol !== POLARIZATION.OFF) {
        // 偏波で局部発振器を切り替える LNBf
        const found = ranges.find(r => inRange(r) && r.pol === polarization);
        if (!found) {
            return null;
        }
        offset = found.lo * 1000;
    } else {
        // 周波数で局部発振器を切り替える LNBf (DiSEqC でバンドを切り替える)
        let j = ranges.findIndex(inRange);
        if (j === -1) {
            return null;
        }
        if (ranges[j].rangeswitch !== 0 && frequency > ranges[j].rangeswitch * 1000 && j + 1 < ranges.length) {
            j++;
        }
        highBand = j !== 0;
        if (options.freqBpf !== 0) {
            // SCR/Unicable (libdvbv5 と同じく符号なし 16 ビットで計算する)
            scr = (Math.floor((Math.floor(frequency / 1000) + options.freqBpf + 2) / 4) - 350) & 0xFFFF;
            offset = (scr + 350) * 4 * 1000;
        } else {
            offset = ranges[j].lo * 1000;
        }
    }

    return {
        // 符号なし 32 ビットで計算する (libdvbv5 と同じく、LNBf と合わない周波数は frontend が受け付けない値になる)
        frequency: (frequency - offset) >>> 0,
        sec: getSecCommands(deliverySystem, polarization, options, lnb, highBand, scr)
    };
}

function getSecCommands(deliverySystem: number, polarization: number, options: SatOptions, lnb: Lnb, isHighBand: boolean, scr: number): SecCommands | null {
    const { satNumber } = options;
    if (satNumber < 0 && scr !== 0) {
        return null;
    }

    let highBand = isHighBand;
    let polV = polarization === POLARIZATION.V || polarization === POLARIZATION.R;
    let voltage18 = false;
    let tone = false;
    if (lnb.freqRanges[0].rangeswitch === 0) {
        // バンドを切り替えない LNBf は、偏波とバンドを DiSEqC で選ばず、トーンも使わない
        polV = false;
        highBand = true;
        voltage18 = deliverySystem === SYS.ISDBS;
    } else if (satNumber < 2) {
        voltage18 = !polV;
        tone = highBand;
    }

    let diseqc: SecCommands["diseqc"] = null;
    if (satNumber >= 0) {
        let command: number[];
        if (scr === 0) {
            // Write to Port group 0 (Committed switches)
            command = [0xE0, 0x10, 0x38, 0xF0 | (highBand ? 1 : 0) | (polV ? 0 : 2) | ((satNumber & 0x3) << 2)];
        } else {
            // ODU Channel Change (SCR/Unicable)
            const data0 = ((scr >> 8) & 0x03) | ((satNumber & 0x7) << 5) | (highBand ? 0 : 4) | (polV ? 8 : 0) | ((satNumber & 0x8) ? 16 : 0);
            command = [0xE0, 0x10, 0x5A, data0 & 0xFF, scr & 0xFF];
        }
        diseqc = {
            command,
            burst: satNumber < 2 ? (satNumber === 0 ? SEC_MINI.A : SEC_MINI.B) : null,
            wait: options.diseqcWait
        };
    }

    return {
        voltage: voltage18 ? SEC_VOLTAGE.V18 : SEC_VOLTAGE.V13,
        tone,
        diseqc
    };
}
