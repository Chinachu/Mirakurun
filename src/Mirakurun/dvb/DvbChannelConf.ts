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
import * as fs from "fs";
import { toAsciiLowerCase, toAsciiUpperCase } from "./ascii";
import { DTV, SYS } from "./constants";
import { Lnb, findLnb, POLARIZATION_NAMES } from "./DvbSat";

export interface DvbChannelParams {
    readonly deliverySystem: number;
    /** DTV_DELIVERY_SYSTEM 以外の [cmd, data] */
    readonly properties: readonly (readonly [number, number])[];
    /** 衛星の LNBf (LNB)、偏波 (POLARIZATION, `POLARIZATION.*`)、衛星の番号 (SAT_NUMBER) */
    readonly lnb?: Lnb;
    readonly polarization?: number;
    readonly satNumber?: number;
}

const DELIVERY_SYSTEMS = new Map<string, number>([
    ["ISDBT", SYS.ISDBT],
    ["ISDBS", SYS.ISDBS]
]);

// libdvbv5 がチャンネルの情報として読み、frontend には設定しない項目 (PID_* も同じ)
const ENTRY_KEYS = new Set(["SERVICE_ID", "VIDEO_PID", "AUDIO_PID", "CHANNEL", "VCHANNEL", "NETWORK_ID", "TRANSPORT_ID"]);

const NUMERIC_KEYS: { [key: string]: number } = {
    FREQUENCY: DTV.FREQUENCY,
    BANDWIDTH_HZ: DTV.BANDWIDTH_HZ,
    SYMBOL_RATE: DTV.SYMBOL_RATE,
    STREAM_ID: DTV.STREAM_ID
};

// 設定ファイルを編集した場合に読み直すため、ファイルの状態と一緒に保持する
const cache = new Map<string, { version: string; channels: DvbChannels }>();

// 更新日時を保ったまま置き換えた場合 (`cp -p` など) も読み直すよう、ctime、大きさ、inode も比べる
function fileVersion(stat: fs.Stats): string {
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

interface DvbChannelEntry {
    /** `[...]` の名前 (libdvbv5 と同じく `[CHANNEL]` は名前なし) */
    readonly name: string | null;
    readonly vchannel: string | null;
    readonly params: DvbChannelParams;
}

const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);

// atoi() (strtol()) と同じく、long の範囲に収める
function clampInt64(value: bigint): bigint {
    return value > INT64_MAX ? INT64_MAX : value < INT64_MIN ? INT64_MIN : value;
}

/** チャンネル設定ファイルのチャンネル (ファイルの順) */
export class DvbChannels {
    constructor(private readonly _entries: readonly DvbChannelEntry[]) {}

    /** 名前が一致する最初のチャンネル */
    get(name: string): DvbChannelParams | undefined {
        return this._entries.find(entry => entry.name === name)?.params;
    }

    /**
     * dvbv5-zap と同じくチャンネルを探す
     * (名前か VCHANNEL が一致する最初のチャンネル、なければ大文字と小文字を区別せずに名前が一致する最初のチャンネル。
     * `byFrequency` の場合は、さらに数値として読んだ値と周波数が一致する最初のチャンネル)
     */
    find(channel: string, byFrequency: boolean): DvbChannelParams | undefined {
        let entry = this._entries.find(e => e.name === channel || e.vchannel === channel);
        if (!entry) {
            const lower = toAsciiLowerCase(channel);
            entry = this._entries.find(e => e.name !== null && toAsciiLowerCase(e.name) === lower);
        }
        if (!entry && byFrequency) {
            // dvbv5-zap は atoi() で読んだ値を uint32_t にし、0 の場合は探さない (先頭の空白は C の isspace() と同じ)
            const frequency = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(channel);
            const value = frequency ? Number(BigInt.asUintN(32, clampInt64(BigInt(frequency[1])))) : 0;
            if (value !== 0) {
                entry = this._entries.find(e => e.params.properties.find(([cmd]) => cmd === DTV.FREQUENCY)?.[1] === value);
            }
        }
        return entry?.params;
    }
}

/** dvbv5 形式のチャンネル設定 (dvbv5_channels_*.conf) を読む */
export function parseDvbv5ChannelsConf(text: string): DvbChannels {
    const entries: DvbChannelEntry[] = [];
    let started = false;
    let name: string | null = null;
    let vchannel: string | null = null;
    let deliverySystem: number = null;
    let properties: [number, number][] = [];
    let sat: { lnb?: Lnb; polarization?: number; satNumber?: number } = {};
    let keys = new Set<string>();

    const label = () => name ?? "CHANNEL";
    const commit = () => {
        if (started === false) {
            return;
        }
        if (deliverySystem === null) {
            throw new Error(`DELIVERY_SYSTEM is missing in [${label()}]`);
        }
        if (keys.has("FREQUENCY") === false) {
            throw new Error(`FREQUENCY is missing in [${label()}]`);
        }
        entries.push({ name, vchannel, params: { deliverySystem, properties, ...sat } });
    };

    // libdvbv5 と同じく、行の先頭の空白だけを除く (値の末尾の空白や CR は値の一部になる)
    for (const rawLine of text.split("\n")) {
        const line = rawLine.replace(/^[ \t]+/, "");
        if (line === "" || line.startsWith("#")) {
            continue;
        }

        // libdvbv5 と同じく、名前は最初の `]` まで (`CHANNEL` は名前なし、先頭の空白は除く)
        const section = /^\[([^\]]*)\]/.exec(line);
        if (section) {
            if (section[1] === "") {
                throw new Error(`invalid line: ${line}`);
            }
            commit();
            started = true;
            name = (toAsciiUpperCase(section[1]) === "CHANNEL" ? "" : section[1]).replace(/^[ \t]+/, "") || null;
            vchannel = null;
            deliverySystem = null;
            properties = [];
            sat = {};
            keys = new Set();
            continue;
        }

        // libdvbv5 は PID_* の番号を小文字の 16 進数で書く
        // (libdvbv5 は `=` の前の最後の 1 文字を消すため、`=` の前に空白がないとキーが変わる)
        const pair = /^([A-Za-z0-9_]+)[ \t]+=[ \t]*([^]*)$/.exec(line);
        if (!pair || started === false) {
            throw new Error(`invalid line: ${line}`);
        }
        const [, key, value] = pair;
        // libdvbv5 は値の末尾の空白を除かず、文字列の値は一致しなくなるため
        if (value === "" || /[ \t\v\f\r]$/.test(value)) {
            throw new Error(`invalid value of ${key} in [${label()}]`);
        }

        // 同じ項目が重複すると、libdvbv5 は項目によって先の値と後の値のどちらかを使うため
        if (keys.has(key)) {
            throw new Error(`duplicate property ${key} in [${label()}]`);
        }
        keys.add(key);

        const lnb = key === "LNB" ? findLnb(value) : null;
        const polarization = key === "POLARIZATION" ? POLARIZATION_NAMES[toAsciiUpperCase(value)] : undefined;

        if (key === "DELIVERY_SYSTEM") {
            if (DELIVERY_SYSTEMS.has(value) === false) {
                throw new Error(`unsupported DELIVERY_SYSTEM ${value} in [${label()}]`);
            }
            deliverySystem = DELIVERY_SYSTEMS.get(value);
        } else if (NUMERIC_KEYS[key] !== undefined && /^\d+$/.test(value) && parseInt(value, 10) <= 0xFFFFFFFF) {
            // libdvbv5 は 32 ビットに収まらない値を切り詰めるため、収まる値に限る
            properties.push([NUMERIC_KEYS[key], parseInt(value, 10)]);
        } else if (lnb !== null) {
            sat.lnb = lnb;
        } else if (polarization !== undefined) {
            sat.polarization = polarization;
        } else if (key === "SAT_NUMBER" && /^-?\d+$/.test(value)) {
            sat.satNumber = parseInt(value, 10);
        } else if ((key === "DISEQC_WAIT" || key === "FREQ_BPF") && /^\d+$/.test(value)) {
            // dvbv5-zap はチャンネル設定のこれらの値を使わない (`-W`, `-U` だけを使う)
        } else if (key === "VCHANNEL") {
            vchannel = value;
        } else if (ENTRY_KEYS.has(key) || key.startsWith("PID_")) {
            // dvbv5-scan が出力するサービスの情報 (libdvbv5 は選局に使わない)
        } else {
            // 未対応の項目を無視すると、意図と異なる設定で選局するため
            throw new Error(`unsupported property ${key} = ${value} in [${label()}]`);
        }
    }
    commit();

    return new DvbChannels(entries);
}

/** チャンネル設定ファイルを読む (更新されていなければ前回の結果を返す) */
export function loadChannelsConf(confPath: string): DvbChannels {
    const version = fileVersion(fs.statSync(confPath));
    const cached = cache.get(confPath);
    if (cached && cached.version === version) {
        return cached.channels;
    }
    return cacheChannels(confPath, version, fs.readFileSync(confPath, "utf8"));
}

/** `loadChannelsConf()` と同じく読む (選局のたびに読むため、イベントループを止めない) */
export async function readChannelsConf(confPath: string): Promise<DvbChannels> {
    const version = fileVersion(await fs.promises.stat(confPath));
    const cached = cache.get(confPath);
    if (cached && cached.version === version) {
        return cached.channels;
    }
    return cacheChannels(confPath, version, await fs.promises.readFile(confPath, "utf8"));
}

function cacheChannels(confPath: string, version: string, text: string): DvbChannels {
    const channels = parseDvbv5ChannelsConf(text);
    cache.set(confPath, { version, channels });
    return channels;
}

/**
 * 読んだチャンネル設定から、チャンネル (`ChannelItem.channel`) の選局パラメーターを探す
 * @param byFrequency 見つからない場合に周波数でも探すか (dvbv5-zap は `-r` がない場合に探す)
 */
export function findChannelParams(channels: DvbChannels, channel: string, confPath: string, byFrequency = false): DvbChannelParams {
    const params = channels.find(channel, byFrequency);
    if (!params) {
        throw new Error(`channel ${channel} is not found in ${confPath}`);
    }
    return params;
}
