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
import * as util from "util";
import EventEmitter = require("eventemitter3");
import * as log from "../log";
import * as linuxDvb from "./linux-dvb";
import { DvbChannelParams } from "./DvbChannelConf";
import { Lnb, POLARIZATION, SecCommands, getSatTuning } from "./DvbSat";
import {
    DTV,
    SATELLITE_SYSTEMS,
    SEC_TONE,
    SEC_VOLTAGE,
    LNA_AUTO,
    PID_ALL,
    DMX_IN_FRONTEND,
    DMX_OUT_TS_TAP,
    DMX_PES_OTHER,
    DMX_IMMEDIATE_START
} from "./constants";

const open = util.promisify(fs.open);
const close = util.promisify(fs.close);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** dvr のバッファー (dvbv5-zap の DVB_BUF_SIZE と同じ。24Mbps で約 2 秒分) */
const DVR_BUFFER_SIZE = 188 * 4096 * 8;
/** 1 回の read で読む上限 */
const READ_SIZE = 188 * 1024;
/** dvr が空の場合に、次に読むまでの間隔 (ミリ秒) */
const READ_INTERVAL = 10;

export interface DvbDeviceOptions {
    readonly adapter: number;
    readonly frontend?: number;
    readonly demux?: number;
    readonly dvr?: number;
    /** 衛星の LNBf。指定しない場合はチャンネル設定の LNB を使う */
    readonly lnb?: Lnb | null;
    /** 衛星の番号 (DiSEqC)。負または指定しない場合はチャンネル設定の SAT_NUMBER を使う */
    readonly satNumber?: number;
    /** DiSEqC の後に追加で待つ時間 (ミリ秒) */
    readonly diseqcWait?: number;
    /** SCR/Unicable のバンドパスフィルターの周波数 (kHz) */
    readonly freqBpf?: number;
    /** `DTV_LNA` の値。`LNA_AUTO` または指定しない場合は設定しない */
    readonly lna?: number;
}

/**
 * DVB デバイスを直接操作する。frontend を開いたまま選局し直せる。
 *
 * events: "data" (chunk: Buffer), "overflow" (), "error" (err: Error)
 */
export default class DvbDevice extends EventEmitter {
    private _frontendFd: number = null;
    private _demuxFd: number = null;
    private _dvrFd: number = null;
    // frontend の現在の伝送方式 (衛星の場合は閉じる前に LNB への給電を止める)
    private _deliverySystem: number = null;

    private _readBuffer: Buffer = null;
    private _readTimer: NodeJS.Timeout = null;
    // 実行中の read の完了 (read の途中で fd を閉じないため)
    private _readDone: Promise<void> = null;

    // open / tune などを順に実行するためのキュー
    private _queue: Promise<unknown> = Promise.resolve();

    constructor(private _options: DvbDeviceOptions) {
        super();
    }

    get path(): string {
        return `/dev/dvb/adapter${this._options.adapter}`;
    }

    get isOpen(): boolean {
        return this._frontendFd !== null;
    }

    get isStreaming(): boolean {
        return this._dvrFd !== null;
    }

    /** 必要なら frontend を開き、選局して配信を始める (配信中なら止めてから選局し直す) */
    start(params: DvbChannelParams): Promise<void> {
        return this._serial(async () => {
            if (this._frontendFd === null) {
                this._frontendFd = await this._openFrontend();
            }
            await this._stopStream();
            await this._tune(params);
            await this._startStream();
        });
    }

    stopStream(): Promise<void> {
        return this._serial(() => this._stopStream());
    }

    close(): Promise<void> {
        return this._serial(async () => {
            await this._stopStream();

            if (this._frontendFd !== null) {
                const fd = this._frontendFd;
                this._frontendFd = null;
                // libdvbv5 と同じく、衛星の場合は LNB への給電を止める
                if (this._isSatellite()) {
                    await linuxDvb.setVoltage(fd, SEC_VOLTAGE.OFF).catch(err => {
                        log.debug("DvbDevice: %s failed to turn off LNB power (%s)", this.path, err.code);
                    });
                }
                this._deliverySystem = null;
                await close(fd);
            }
        });
    }

    private async _openFrontend(): Promise<number> {
        const fd = await open(`${this.path}/frontend${this._options.frontend || 0}`, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        this._deliverySystem = await linuxDvb.getDeliverySystem(fd).catch(() => null);
        return fd;
    }

    private _isSatellite(deliverySystem = this._deliverySystem): boolean {
        return SATELLITE_SYSTEMS.includes(deliverySystem);
    }

    // dvbv5-zap (libdvbv5) と同じ順に、伝送方式、LNA、LNB を設定してから選局する (ロックを待たずに返る)
    private async _tune(params: DvbChannelParams): Promise<void> {
        const fd = this._getFrontendFd();
        const { deliverySystem } = params;

        if (deliverySystem !== this._deliverySystem) {
            if (this._isSatellite() && this._isSatellite(deliverySystem) === false) {
                await linuxDvb.setVoltage(fd, SEC_VOLTAGE.OFF).catch(err => {
                    log.debug("DvbDevice: %s failed to turn off LNB power (%s)", this.path, err.code);
                });
            }
            await linuxDvb.setProperties(fd, [[DTV.DELIVERY_SYSTEM, deliverySystem]]);
            this._deliverySystem = deliverySystem;
        }

        // dvbv5-zap と同じく選局のたびに設定する (set_lna がないドライバーでは何もせずに成功する)
        const lna = this._options.lna ?? LNA_AUTO;
        if (lna !== LNA_AUTO) {
            await linuxDvb.setProperties(fd, [[DTV.LNA, lna]]).catch(err => {
                log.warn("DvbDevice: %s failed to set LNA (%s)", this.path, err.code);
            });
        }

        let properties = params.properties;
        if (this._isSatellite(deliverySystem)) {
            const frequency = properties.find(([cmd]) => cmd === DTV.FREQUENCY)?.[1] ?? 0;
            const satNumber = this._options.satNumber ?? -1;
            const tuning = getSatTuning(deliverySystem, frequency, params.polarization ?? POLARIZATION.OFF, {
                lnb: this._options.lnb ?? params.lnb ?? null,
                satNumber: satNumber >= 0 ? satNumber : params.satNumber ?? -1,
                diseqcWait: this._options.diseqcWait ?? 0,
                freqBpf: this._options.freqBpf ?? 0
            });
            if (tuning !== null) {
                // LNB の操作に失敗しても、dvbv5-zap と同じく選局は続ける
                // (22kHz トーンに対応しないドライバーでは毎回失敗するため、dvbv5-zap の出力と同じく debug で記録する)
                if (tuning.sec !== null) {
                    await this._sendSecCommands(fd, tuning.sec).catch(err => {
                        log.debug("DvbDevice: %s failed to control LNB (%s)", this.path, err.code || err.message);
                    });
                }
                properties = properties.map(prop => prop[0] === DTV.FREQUENCY ? [DTV.FREQUENCY, tuning.frequency] as const : prop);
            }
        }

        await linuxDvb.setProperties(fd, [
            [DTV.CLEAR, 0],
            [DTV.DELIVERY_SYSTEM, deliverySystem],
            ...properties,
            [DTV.TUNE, 0]
        ]);
    }

    private async _sendSecCommands(fd: number, sec: SecCommands): Promise<void> {
        await linuxDvb.setVoltage(fd, sec.voltage);
        await linuxDvb.setTone(fd, SEC_TONE.OFF);

        if (sec.diseqc !== null) {
            await sleep(15);
            await linuxDvb.sendDiseqcCommand(fd, sec.diseqc.command);
            await sleep(15 + sec.diseqc.wait);
            if (sec.diseqc.burst !== null) {
                await linuxDvb.sendDiseqcBurst(fd, sec.diseqc.burst);
            }
            await sleep(15);
        }

        await linuxDvb.setTone(fd, sec.tone ? SEC_TONE.ON : SEC_TONE.OFF);
    }

    private async _startStream(): Promise<void> {
        this._getFrontendFd();
        if (this._dvrFd !== null) {
            return;
        }

        // dvr を開く前の出力は捨てられるため、dvr を先に開く
        const dvrFd = await open(`${this.path}/dvr${this._options.dvr || 0}`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        let demuxFd: number = null;
        try {
            await linuxDvb.setBufferSize(dvrFd, DVR_BUFFER_SIZE).catch(err => {
                log.warn("DvbDevice: %s failed to set dvr buffer size (%s)", this.path, err.code);
            });

            demuxFd = await open(`${this.path}/demux${this._options.demux || 0}`, fs.constants.O_RDWR);
            await linuxDvb.setPesFilter(demuxFd, {
                pid: PID_ALL,
                input: DMX_IN_FRONTEND,
                output: DMX_OUT_TS_TAP,
                pesType: DMX_PES_OTHER,
                flags: DMX_IMMEDIATE_START
            });
        } catch (err) {
            await close(dvrFd);
            if (demuxFd !== null) {
                await close(demuxFd);
            }
            throw err;
        }

        this._demuxFd = demuxFd;
        this._startReading(dvrFd);
    }

    private async _stopStream(): Promise<void> {
        if (this._dvrFd === null) {
            return;
        }

        await this._stopReading();

        // demux を閉じるとフィルターも止まる
        const demuxFd = this._demuxFd;
        this._demuxFd = null;
        await close(demuxFd);
    }

    private _startReading(fd: number): void {
        this._dvrFd = fd;
        if (this._readBuffer === null) {
            this._readBuffer = Buffer.allocUnsafeSlow(READ_SIZE);
        }
        this._read();
    }

    private async _stopReading(): Promise<void> {
        const fd = this._dvrFd;
        this._dvrFd = null;
        clearTimeout(this._readTimer);
        this._readTimer = null;

        if (this._readDone !== null) {
            await this._readDone;
        }
        await close(fd);
    }

    private _read(): void {
        this._readTimer = null;
        const fd = this._dvrFd;
        if (fd === null) {
            return;
        }

        this._readDone = new Promise(resolve => {
            fs.read(fd, this._readBuffer, 0, READ_SIZE, null, (err, bytesRead) => {
                this._readDone = null;
                resolve();

                if (this._dvrFd !== fd) {
                    return;
                }

                if (err) {
                    const code = (err as NodeJS.ErrnoException).code;
                    if (code === "EAGAIN") {
                        this._readTimer = setTimeout(() => this._read(), READ_INTERVAL);
                    } else if (code === "EOVERFLOW") {
                        // カーネルはバッファーを捨てて EOVERFLOW を返すため、そのまま読み続ける
                        this.emit("overflow");
                        this._read();
                    } else {
                        this.emit("error", err);
                    }
                    return;
                }

                if (bytesRead > 0) {
                    // 読み込み用のバッファーは使い回すため、渡す分はコピーする
                    this.emit("data", Buffer.copyBytesFrom(this._readBuffer, 0, bytesRead));
                }
                if (bytesRead === READ_SIZE) {
                    this._read();
                } else {
                    this._readTimer = setTimeout(() => this._read(), READ_INTERVAL);
                }
            });
        });
    }

    private _getFrontendFd(): number {
        if (this._frontendFd === null) {
            throw new Error(`${this.path} is not open`);
        }
        return this._frontendFd;
    }

    private _serial<T>(fn: () => Promise<T>): Promise<T> {
        const result = this._queue.then(fn);
        this._queue = result.catch(() => { /* 次の処理には伝えない */ });
        return result;
    }
}
