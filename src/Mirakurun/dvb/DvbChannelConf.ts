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
import * as path from "path";
import * as apid from "../../../api";
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

const CONF_DIR = path.resolve(__dirname, "../../../config/dvbconf-for-isdb/conf");

const DELIVERY_SYSTEMS = new Map<string, number>([
    ["ISDBT", SYS.ISDBT],
    ["ISDBS", SYS.ISDBS]
]);

const NUMERIC_KEYS: { [key: string]: number } = {
    FREQUENCY: DTV.FREQUENCY,
    BANDWIDTH_HZ: DTV.BANDWIDTH_HZ,
    SYMBOL_RATE: DTV.SYMBOL_RATE,
    STREAM_ID: DTV.STREAM_ID
};

// 設定ファイルを編集した場合に読み直すため、更新日時と一緒に保持する
const cache = new Map<string, { mtimeMs: number; channels: Map<string, DvbChannelParams> }>();

/** dvbv5 形式のチャンネル設定 (dvbv5_channels_*.conf) を読む */
export function parseDvbv5ChannelsConf(text: string): Map<string, DvbChannelParams> {
    const channels = new Map<string, DvbChannelParams>();
    let name: string = null;
    let deliverySystem: number = null;
    let properties: [number, number][] = [];
    let sat: { lnb?: Lnb; polarization?: number; satNumber?: number } = {};

    const commit = () => {
        if (name === null) {
            return;
        }
        if (deliverySystem === null) {
            throw new Error(`DELIVERY_SYSTEM is missing in [${name}]`);
        }
        // dvbv5-zap と同じく、同じ名前のチャンネルは先のものを使う
        if (channels.has(name) === false) {
            channels.set(name, { deliverySystem, properties, ...sat });
        }
    };

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }

        const section = /^\[(.+)\]$/.exec(line);
        if (section) {
            commit();
            name = section[1];
            deliverySystem = null;
            properties = [];
            sat = {};
            continue;
        }

        const pair = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
        if (!pair || name === null) {
            throw new Error(`invalid line: ${line}`);
        }
        const [, key, value] = pair;

        const lnb = key === "LNB" ? findLnb(value) : null;
        const polarization = key === "POLARIZATION" ? POLARIZATION_NAMES[value.toUpperCase()] : undefined;

        if (key === "DELIVERY_SYSTEM") {
            if (DELIVERY_SYSTEMS.has(value) === false) {
                throw new Error(`unsupported DELIVERY_SYSTEM ${value} in [${name}]`);
            }
            deliverySystem = DELIVERY_SYSTEMS.get(value);
        } else if (NUMERIC_KEYS[key] !== undefined && /^\d+$/.test(value)) {
            properties.push([NUMERIC_KEYS[key], parseInt(value, 10)]);
        } else if (lnb !== null) {
            sat.lnb = lnb;
        } else if (polarization !== undefined) {
            sat.polarization = polarization;
        } else if (key === "SAT_NUMBER" && /^-?\d+$/.test(value)) {
            sat.satNumber = parseInt(value, 10);
        } else if ((key === "DISEQC_WAIT" || key === "FREQ_BPF") && /^\d+$/.test(value)) {
            // dvbv5-zap はチャンネル設定のこれらの値を使わない (`-W`, `-U` だけを使う)
        } else {
            // 未対応の項目を無視すると、意図と異なる設定で選局するため
            throw new Error(`unsupported property ${key} = ${value} in [${name}]`);
        }
    }
    commit();

    return channels;
}

export function getDefaultConfPath(type: apid.ChannelType): string {
    switch (type) {
        case "GR":
            return path.join(CONF_DIR, "dvbv5_channels_isdbt.conf");
        case "BS":
        case "CS":
            return path.join(CONF_DIR, "dvbv5_channels_isdbs.conf");
        default:
            throw new Error(`channel type ${type} is not supported by DVB tuning`);
    }
}

/** チャンネル設定ファイルを読む (更新されていなければ前回の結果を返す) */
export function loadChannelsConf(confPath: string): Map<string, DvbChannelParams> {
    const { mtimeMs } = fs.statSync(confPath);
    let cached = cache.get(confPath);
    if (!cached || cached.mtimeMs !== mtimeMs) {
        cached = { mtimeMs, channels: parseDvbv5ChannelsConf(fs.readFileSync(confPath, "utf8")) };
        cache.set(confPath, cached);
    }
    return cached.channels;
}

/** チャンネル (`ChannelItem.channel`) の選局パラメーターを返す */
export function getChannelParams(type: apid.ChannelType, channel: string, confPath = getDefaultConfPath(type)): DvbChannelParams {
    const channels = loadChannelsConf(confPath);
    let params = channels.get(channel);
    if (!params) {
        // dvbv5-zap と同じく、見つからなければ大文字と小文字を区別せずに探す
        const lower = channel.toLowerCase();
        for (const [name, value] of channels) {
            if (name.toLowerCase() === lower) {
                params = value;
                break;
            }
        }
    }
    if (!params) {
        throw new Error(`channel ${channel} is not found in ${confPath}`);
    }
    return params;
}
