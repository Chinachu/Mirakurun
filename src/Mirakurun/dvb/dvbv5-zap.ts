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

// チューナーの設定の dvbv5-zap コマンドを解釈して、DVB デバイスを直接操作する設定に置き換える

import * as path from "path";
import * as common from "../common";
import { LNA_AUTO } from "./constants";
import { Lnb, findLnb } from "./DvbSat";

export interface DvbDirectOptions {
    readonly adapter: number;
    readonly frontend: number;
    readonly demux: number;
    readonly dvr: number;
    /** dvbv5 形式のチャンネル設定ファイル (-c) */
    readonly channelsConfPath: string;
    /** LNBf (-l)。null の場合はチャンネル設定の LNB を使う */
    readonly lnb: Lnb | null;
    /** 衛星の番号 (-S)。負の場合はチャンネル設定の SAT_NUMBER を使う */
    readonly satNumber: number;
    /** DiSEqC の後に追加で待つ時間 (-W, ミリ秒) */
    readonly diseqcWait: number;
    /** SCR/Unicable のバンドパスフィルターの周波数 (-U, kHz) */
    readonly freqBpf: number;
    /** LNA (-w)。`LNA_AUTO` の場合は設定しない */
    readonly lna: number;
}

// 選局と出力に影響しないため、直接操作する場合は無視してよいオプション
const IGNORABLE_FLAGS: { [name: string]: string } = {
    P: "all-pids",
    r: "record",
    s: "silence",
    v: "verbose",
    N: "non-numan"
};
const VALUE_OPTIONS: { [name: string]: string } = {
    a: "adapter",
    f: "frontend",
    d: "demux",
    c: "channels",
    I: "input-format",
    o: "output",
    l: "lnbf",
    S: "sat_number",
    U: "freq_bpf",
    W: "wait",
    w: "lna"
};

/**
 * dvbv5-zap のコマンド (テンプレート) を解釈する。
 * dvbv5-zap でなければ null を返し、直接操作できないオプションがあれば理由を投げる。
 */
export function parseDvbv5ZapCommand(command: string, dvbDevicePath?: string): DvbDirectOptions | null {
    const { command: bin, args } = common.parseCommandForSpawn(command);
    if (path.basename(bin) !== "dvbv5-zap") {
        return null;
    }

    const flags = new Set<string>();
    const values: { [name: string]: string } = {};
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith("--")) {
            const [longName, inlineValue] = splitOnce(arg.slice(2), "=");
            const short = findShortName(longName);
            if (short === null) {
                throw new Error(`unsupported option \`${arg}\``);
            }
            if (VALUE_OPTIONS[short]) {
                values[short] = inlineValue ?? args[++i];
            } else if (inlineValue !== undefined) {
                throw new Error(`unexpected value of \`--${longName}\``);
            } else {
                flags.add(short);
            }
            continue;
        }

        if (arg.startsWith("-") && arg.length > 1) {
            // -rP のようにまとめたフラグと、-a0 のように値を続けたオプション
            for (let j = 1; j < arg.length; j++) {
                const short = arg[j];
                if (VALUE_OPTIONS[short]) {
                    values[short] = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
                    break;
                }
                if (!IGNORABLE_FLAGS[short]) {
                    throw new Error(`unsupported option \`-${short}\``);
                }
                flags.add(short);
            }
            continue;
        }

        positionals.push(arg);
    }

    for (const [short, value] of Object.entries(values)) {
        if (value === undefined) {
            throw new Error(`missing value of \`-${short}\``);
        }
        if (/<[^>]*>/.test(value)) {
            throw new Error(`template variable in \`-${short} ${value}\``);
        }
    }
    if (positionals.length !== 1 || positionals[0] !== "<channel>") {
        throw new Error(`the channel argument must be only \`<channel>\``);
    }
    // -P がない場合は映像と音声の PID だけを出力するため、出力が変わる
    if (!flags.has("P")) {
        throw new Error("`-P` is required");
    }
    if (values.I !== undefined && values.I.toUpperCase() !== "DVBV5") {
        throw new Error(`unsupported input format \`${values.I}\``);
    }
    if (values.o !== undefined && values.o !== "-") {
        throw new Error(`output to file \`${values.o}\``);
    }
    if (values.c === undefined) {
        throw new Error("`-c` is required");
    }

    const adapter = parseIndex("a", values.a);
    const frontend = parseIndex("f", values.f);
    const demux = parseIndex("d", values.d);
    // dvbv5-zap は demux と同じ番号の dvr を使う
    const dvr = demux;

    if (dvbDevicePath && path.resolve(dvbDevicePath) !== `/dev/dvb/adapter${adapter}/dvr${dvr}`) {
        throw new Error(`dvbDevicePath \`${dvbDevicePath}\` does not match the adapter and demux`);
    }

    let lnb: Lnb | null = null;
    if (values.l !== undefined) {
        lnb = findLnb(values.l);
        if (lnb === null) {
            throw new Error(`unknown LNBf \`${values.l}\``);
        }
    }
    if (values.S !== undefined && /^-?\d+$/.test(values.S) === false) {
        throw new Error(`invalid value of \`-S ${values.S}\``);
    }

    return {
        adapter,
        frontend,
        demux,
        dvr,
        channelsConfPath: path.resolve(values.c),
        lnb,
        satNumber: values.S === undefined ? -1 : parseInt(values.S, 10),
        diseqcWait: parseIndex("W", values.W),
        freqBpf: parseIndex("U", values.U),
        lna: parseLna(values.w)
    };
}

/** `-w` の値 (on, off, auto または数値。dvbv5-zap と同じく 0 は off、正は on、負は auto) */
function parseLna(value: string | undefined): number {
    if (value === undefined || value.toLowerCase() === "auto") {
        return LNA_AUTO;
    }
    if (value.toLowerCase() === "on") {
        return 1;
    }
    if (value.toLowerCase() === "off") {
        return 0;
    }
    if (/^-?\d+$/.test(value) === false) {
        throw new Error(`invalid value of \`-w ${value}\``);
    }
    const n = parseInt(value, 10);
    return n === 0 ? 0 : n > 0 ? 1 : LNA_AUTO;
}

function findShortName(longName: string): string | null {
    for (const table of [IGNORABLE_FLAGS, VALUE_OPTIONS]) {
        for (const short in table) {
            if (table[short] === longName) {
                return short;
            }
        }
    }
    return null;
}

function splitOnce(str: string, separator: string): [string, string | undefined] {
    const index = str.indexOf(separator);
    return index === -1 ? [str, undefined] : [str.slice(0, index), str.slice(index + 1)];
}

function parseIndex(short: string, value: string | undefined): number {
    if (value === undefined) {
        return 0;
    }
    if (/^\d+$/.test(value) === false) {
        throw new Error(`invalid value of \`-${short} ${value}\``);
    }
    return parseInt(value, 10);
}
