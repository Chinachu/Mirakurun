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

// Linux DVB API の ioctl を koffi (FFI) で呼び出す。koffi を使うのはこのファイルだけにする。

import * as util from "util";
import type * as Koffi from "koffi" with { "resolution-mode": "import" };
import { DTV, MAX_DTV_STATS } from "./constants";

// koffi の型定義は ESM として扱われるため、型だけを import して require() で読み込む
const koffi: typeof Koffi = require("koffi");

// ioctl 番号は asm-generic の形式で計算するため、それ以外の形式のアーキテクチャには対応しない
const SUPPORTED_ARCHS = ["x64", "ia32", "arm", "arm64", "riscv64", "loong64"];

if (SUPPORTED_ARCHS.includes(process.arch) === false) {
    throw new Error(`Linux DVB API is not supported on ${process.arch}`);
}

// 構造体 (uapi と同じレイアウト。ポインターの幅で大きさが変わるものがある)
const dtvStats = koffi.pack({
    scale: "uint8",
    value: "int64"
});
const dtvFeStats = koffi.pack({
    len: "uint8",
    stat: koffi.array(dtvStats, MAX_DTV_STATS)
});
const dtvPropertyBuffer = koffi.struct({
    data: koffi.array("uint8", 32),
    len: "uint32",
    reserved1: koffi.array("uint32", 3),
    reserved2: "void *"
});
const dtvProperty = koffi.pack({
    cmd: "uint32",
    reserved: koffi.array("uint32", 3),
    u: koffi.union({
        data: "uint32",
        st: dtvFeStats,
        buffer: dtvPropertyBuffer
    }),
    result: "int"
});
const dtvProperties = koffi.struct({
    num: "uint32",
    props: "void *"
});
const dvbDiseqcMasterCmd = koffi.struct({
    msg: koffi.array("uint8", 6),
    msg_len: "uint8"
});

const dmxPesFilterParams = koffi.struct({
    pid: "uint16",
    input: "int",
    output: "int",
    pes_type: "int",
    flags: "uint32"
});

export const sizes = {
    dtvProperty: koffi.sizeof(dtvProperty),
    dtvProperties: koffi.sizeof(dtvProperties),
    dvbDiseqcMasterCmd: koffi.sizeof(dvbDiseqcMasterCmd),
    dmxPesFilterParams: koffi.sizeof(dmxPesFilterParams)
};

const PROPERTY_U = koffi.offsetof(dtvProperty, "u");
const DISEQC_MSG_LEN = koffi.offsetof(dvbDiseqcMasterCmd, "msg_len");

// asm-generic の _IOC()
const IOC_NONE = 0;
const IOC_WRITE = 1;
const IOC_READ = 2;

function ioc(dir: number, nr: number, size: number): number {
    return ((dir << 30) | (size << 16) | (0x6F << 8) | nr) >>> 0; // type = 'o'
}

export const requests = {
    FE_SET_PROPERTY: ioc(IOC_WRITE, 82, sizes.dtvProperties),
    FE_GET_PROPERTY: ioc(IOC_READ, 83, sizes.dtvProperties),
    FE_DISEQC_SEND_MASTER_CMD: ioc(IOC_WRITE, 63, sizes.dvbDiseqcMasterCmd),
    FE_DISEQC_SEND_BURST: ioc(IOC_NONE, 65, 0),
    FE_SET_TONE: ioc(IOC_NONE, 66, 0),
    FE_SET_VOLTAGE: ioc(IOC_NONE, 67, 0),
    DMX_SET_PES_FILTER: ioc(IOC_WRITE, 44, sizes.dmxPesFilterParams),
    DMX_SET_BUFFER_SIZE: ioc(IOC_NONE, 45, 0)
};

// koffi は可変長引数の関数を非同期で呼べないため、引数を固定して宣言する
// (対応するアーキテクチャでは、整数とポインターの可変長引数は固定引数と同じ渡し方になる)
const libc = koffi.load(null);
const ioctlPointer = libc.func("ioctl", "int", ["int", "unsigned long", "void *"]);
const ioctlValue = libc.func("ioctl", "int", ["int", "unsigned long", "unsigned long"]);

/** ioctl を別スレッドで呼ぶ (ドライバーの処理を待つ間、イベントループを止めないため) */
export function ioctl(fd: number, request: number, arg: Buffer | number = 0): Promise<number> {
    return new Promise((resolve, reject) => {
        const callback = (err: Error, result: number) => {
            if (err) {
                reject(err);
            } else if (result < 0) {
                reject(errnoException(koffi.errno(), "ioctl"));
            } else {
                resolve(result);
            }
        };

        if (Buffer.isBuffer(arg)) {
            ioctlPointer.async(fd, request, arg, callback);
        } else {
            ioctlValue.async(fd, request, arg, callback);
        }
    });
}

function errnoException(errno: number, syscall: string): NodeJS.ErrnoException {
    // getSystemErrorName() は 0 以上の値で例外を投げる (非同期のコールバックの中で投げると捕捉できない)
    const code = errno > 0 ? util.getSystemErrorName(-errno) : "UNKNOWN";
    return Object.assign(new Error(`${syscall} ${code}`), { errno: -errno, code, syscall });
}

/** FE_SET_PROPERTY で [cmd, data] の組を順に設定する */
export async function setProperties(fd: number, properties: readonly (readonly [number, number])[]): Promise<void> {
    const props = Buffer.alloc(sizes.dtvProperty * properties.length);
    properties.forEach(([cmd, data], i) => {
        const offset = sizes.dtvProperty * i;
        koffi.encode(props, offset, "uint32", cmd);
        koffi.encode(props, offset + PROPERTY_U, "uint32", data);
    });

    await ioctl(fd, requests.FE_SET_PROPERTY, encodeProperties(props, properties.length));
}

/** FE_GET_PROPERTY で cmd を 1 つ取得し、結果の dtv_property を返す */
async function getProperty(fd: number, cmd: number): Promise<Buffer> {
    const props = Buffer.alloc(sizes.dtvProperty);
    koffi.encode(props, 0, "uint32", cmd);

    await ioctl(fd, requests.FE_GET_PROPERTY, encodeProperties(props, 1));
    return props;
}

function encodeProperties(props: Buffer, num: number): Buffer {
    const header = Buffer.alloc(sizes.dtvProperties);
    koffi.encode(header, dtvProperties, { num, props });
    return header;
}

/** 現在の伝送方式 (`SYS_*`) */
export async function getDeliverySystem(fd: number): Promise<number> {
    const prop = await getProperty(fd, DTV.DELIVERY_SYSTEM);
    return koffi.decode(prop, PROPERTY_U, "uint32");
}

export async function setPesFilter(fd: number, params: { pid: number; input: number; output: number; pesType: number; flags: number }): Promise<void> {
    const buffer = Buffer.alloc(sizes.dmxPesFilterParams);
    koffi.encode(buffer, dmxPesFilterParams, {
        pid: params.pid,
        input: params.input,
        output: params.output,
        pes_type: params.pesType,
        flags: params.flags
    });

    await ioctl(fd, requests.DMX_SET_PES_FILTER, buffer);
}

export async function setBufferSize(fd: number, size: number): Promise<void> {
    await ioctl(fd, requests.DMX_SET_BUFFER_SIZE, size);
}

/** LNB への給電 (`SEC_VOLTAGE.*`) */
export async function setVoltage(fd: number, voltage: number): Promise<void> {
    await ioctl(fd, requests.FE_SET_VOLTAGE, voltage);
}

/** 22kHz トーン (`SEC_TONE.*`) */
export async function setTone(fd: number, tone: number): Promise<void> {
    await ioctl(fd, requests.FE_SET_TONE, tone);
}

/** mini-DiSEqC (トーンバースト, `SEC_MINI.*`) */
export async function sendDiseqcBurst(fd: number, mini: number): Promise<void> {
    await ioctl(fd, requests.FE_DISEQC_SEND_BURST, mini);
}

/** DiSEqC のコマンド (最大 6 バイト) */
export async function sendDiseqcCommand(fd: number, msg: readonly number[]): Promise<void> {
    if (msg.length > DISEQC_MSG_LEN) {
        throw new Error(`DiSEqC command is too long (${msg.length} bytes)`);
    }
    const buffer = Buffer.alloc(sizes.dvbDiseqcMasterCmd);
    buffer.set(msg);
    buffer[DISEQC_MSG_LEN] = msg.length;
    await ioctl(fd, requests.FE_DISEQC_SEND_MASTER_CMD, buffer);
}
