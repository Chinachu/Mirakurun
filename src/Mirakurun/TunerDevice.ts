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
import * as child_process from "child_process";
import * as stream from "stream";
import * as util from "util";
import EventEmitter = require("eventemitter3");
import * as common from "./common";
import * as log from "./log";
import * as config from "./config";
import * as apid from "../../api";
import status from "./status";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import Client, { ProgramsQuery } from "../client";
import type DvbDevice from "./dvb/DvbDevice";
import { findDvbv5ZapChannelsConf, parseDvbv5ZapCommand } from "./dvb/dvbv5-zap";
import { DvbChannels, findChannelParams, loadChannelsConf, readChannelNames, readChannelsConf } from "./dvb/DvbChannelConf";

/** 出力をまとめて書き出すまでに保留する入力の上限 (バイト数とミリ秒) */
const FLUSH_BYTES = 128 * 1024;
const FLUSH_INTERVAL = 50;

/** 最後のユーザーが終了してから、チューナーを止めるまでの時間 (ミリ秒) */
const END_STREAM_DELAY = 3000;
/** DVB デバイスを直接操作する場合に、止めてから frontend を閉じるまでの時間 (ミリ秒) */
const DVB_CLOSE_DELAY = 1000;
/** DVB デバイスの読み出しに失敗した場合に、閉じてから選局し直すまでの時間 (ミリ秒。コマンドのプロセスが終了した場合と同じ) */
const DVB_RESPAWN_DELAY = 1000;
/** DVB デバイスを開けない場合のうち、デバイスがないことを示すエラー */
const DVB_MISSING_DEVICE_ERRORS = ["ENOENT", "ENODEV", "ENXIO"];
/** リモートの Mirakurun が要求を断った場合 (400 / 404 / 406。起動し直しても同じく断られる) の `lib/remote` の終了コード */
const REMOTE_REFUSED_EXIT_CODE = 2;
/** リモートの Mirakurun が判別した相対 TS の指定 (`tsmfRelTs`) に対応しない場合 (4.3.0 以前) の `lib/remote` の終了コード */
const REMOTE_RELTS_UNSUPPORTED_EXIT_CODE = 3;
/** リモートの Mirakurun に断られた相対 TS (リモートで判別されていないなど) を、そのチューナーで要求しない時間 (ミリ秒) */
const REMOTE_REFUSED_RELTS_PERIOD = 1000 * 60 * 10;
/** リモートの Mirakurun が判別した相対 TS に対応するかを確認できなかった場合に、確認し直すまでの時間 (ミリ秒) */
const REMOTE_RELTS_CHECK_INTERVAL = 1000 * 10;
/** リモートの Mirakurun が判別した相対 TS に対応しない場合に、確認し直すまでの時間 (ミリ秒。リモートがアップデートされた場合のため) */
const REMOTE_RELTS_RECHECK_INTERVAL = 1000 * 60 * 10;
/** リモートの Mirakurun でチャンネルの相対 TS が判別されているかを、確認し直すまでの時間 (ミリ秒) */
const REMOTE_CHANNEL_RELTS_CHECK_INTERVAL = 1000 * 60;

// koffi (FFI) は DVB デバイスを直接操作するチューナーがある場合だけ読み込む
let dvbDeviceClass: typeof DvbDevice | null;
function loadDvbDevice(): typeof DvbDevice | null {
    if (dvbDeviceClass === undefined) {
        try {
            dvbDeviceClass = (require("./dvb/DvbDevice") as typeof import("./dvb/DvbDevice")).default;
        } catch (err) {
            log.warn("TunerDevice: DVB device direct access is unavailable (%s)", err.message);
            dvbDeviceClass = null;
        }
    }
    return dvbDeviceClass;
}

interface User extends common.User {
    _stream?: common.StreamSink;
}

export interface TunerDeviceStatus {
    readonly index: number;
    readonly name: string;
    readonly types: apid.ChannelType[];
    readonly routes?: apid.ChannelRoute[];
    readonly command: string;
    readonly pid: number;
    readonly users: common.User[];
    readonly isAvailable: boolean;
    readonly isRemote: boolean;
    readonly isFree: boolean;
    readonly isUsing: boolean;
    readonly isFault: boolean;
}

export default class TunerDevice extends EventEmitter {
    private _channel: ChannelItem = null;
    private _command: string = null;
    private _process: child_process.ChildProcess = null;
    private _stream: stream.Readable = null;

    private _users = new Set<User>();

    // 書き出しを保留している入力のバイト数と、保留の期限のタイマー
    private _pendingBytes = 0;
    private _flushTimer: NodeJS.Timeout = null;
    private _flushUsersBound = this._flushUsers.bind(this);

    // spawn してから最初の入力までの時間を計測するための spawn 時刻 (0 は計測済み)
    private _spawnedAt = 0;

    private _endStreamTimer: NodeJS.Timeout = null;

    // dvbv5-zap のコマンドの代わりに、DVB デバイスを直接操作する場合
    private _dvb: DvbDevice = null;
    private _dvbChannelsConfPath: string = null;
    /** when the command has `<route>` (e.g. `-c dvbv5_channels_<route>.conf`) */
    private _dvbChannelsConfPathByRoute: Partial<Record<apid.ChannelRoute, string>> = null;
    private _dvbChannelByFrequency = false;
    // DVB デバイスで選局してから止めるまでの間 (コマンドのプロセスがある間に相当)
    private _dvbActive = false;
    // 選局の途中で止めた場合に、選局の結果を無視するための世代
    private _dvbGeneration = 0;
    private _dvbCloseTimer: NodeJS.Timeout = null;

    private _isAvailable = true;
    private _isRemote = false;
    /** the relative stream of TSMF the remote Mirakurun outputs (`undefined`: the stream of the channel) */
    private _remoteRelTs: number;
    /** the format the remote Mirakurun outputs */
    private _remoteFormat: apid.StreamFormat;
    /** the remote Mirakurun supports `tsmfRelTs` of the channel stream (`undefined`: not known yet) */
    private _remoteRelTsSupported: boolean;
    private _remoteRelTsChecking: Promise<boolean> = null;
    private _remoteRelTsRetryTimer: NodeJS.Timeout = null;
    private _remoteRelTsCheckFailed = false;
    /** the relative streams refused by the remote Mirakurun (`type/channel/relTs`: the time) */
    private _remoteRelTsRefused = new Map<string, number>();
    /** the relative streams of the channels checked whether detected by the remote Mirakurun (`type/channel/relTs`: the time) */
    private _remoteChannelRelTsCheckedAt = new Map<string, number>();
    private _isFault = false;
    private _fatalCount = 0;
    private _exited = false;
    private _closing = false;

    constructor(private _index: number, private _config: apid.ConfigTunersItem) {
        super();
        this._isRemote = !!this._config.remoteMirakurunHost;
        if (this._isRemote === false && this._config.disableDvbDirect !== true) {
            this._initDvb();
        }
        Event.emit("tuner", "create", this.toJSON());
        log.debug("TunerDevice#%d initialized", this._index);
    }

    get index(): number {
        return this._index;
    }

    get config(): apid.ConfigTunersItem {
        return this._config;
    }

    get channel(): ChannelItem {
        return this._channel;
    }

    get command(): string {
        return this._command;
    }

    get pid(): number {
        return this._process ? this._process.pid : null;
    }

    get users(): User[] {
        return [...this._users].map(user => {
            return {
                id: user.id,
                priority: user.priority,
                agent: user.agent,
                url: user.url,
                disableDecoder: user.disableDecoder,
                streamSetting: user.streamSetting,
                streamInfo: user.streamInfo
            };
        });
    }

    get decoder(): string | null {
        if (this._isRemote && this._config.remoteMirakurunDecoder === true) {
            return null;
        }
        return this._config.decoder || null;
    }

    get isAvailable(): boolean {
        return this._isAvailable;
    }

    get isRemote(): boolean {
        return this._isRemote;
    }

    /** the relative stream of TSMF the remote Mirakurun outputs (`undefined`: the stream of the channel) */
    get remoteRelTs(): number {
        return this._remoteRelTs;
    }

    /** the format the remote Mirakurun outputs */
    get remoteFormat(): apid.StreamFormat {
        return this._remoteFormat;
    }

    /**
     * the remote Mirakurun outputs the relative stream of TSMF detected (`tsmfRelTs` of the channel stream),
     * `false` until checked by `checkRemoteRelTs()` (not for 4.3.0 or before)
     */
    get supportsRemoteRelTs(): boolean {
        return this._remoteRelTsSupported === true;
    }

    /** checked whether the remote Mirakurun supports the relative stream of TSMF detected (`supportsRemoteRelTs` is known) */
    get isRemoteRelTsChecked(): boolean {
        return this._remoteRelTsSupported !== undefined;
    }

    get isFree(): boolean {
        return this._isAvailable === true && this._channel === null && this._users.size === 0;
    }

    get isUsing(): boolean {
        return this._isAvailable === true && this._channel !== null && this._users.size !== 0;
    }

    get isFault(): boolean {
        return this._isFault;
    }

    private get _isRunning(): boolean {
        return this._dvbActive || this._stream !== null;
    }

    /**
     * the channels of the channel config file of dvbv5-zap of the command for the route (in the order of the file),
     * `null` if the command is not dvbv5-zap (with or without DVB device direct access)
     */
    async getDvbChannelNames(route: apid.ChannelRoute): Promise<string[] | null> {
        const confPath = this._config.command ? findDvbv5ZapChannelsConf(this._config.command.replace(/<route>/g, route.toLowerCase())) : null;
        return confPath ? readChannelNames(confPath) : null;
    }

    getPriority(): number {
        let priority = -2;

        for (const user of this._users) {
            if (user.priority > priority) {
                priority = user.priority;
            }
        }

        return priority;
    }

    toJSON(): TunerDeviceStatus {
        return {
            index: this._index,
            name: this._config.name,
            types: this._config.types,
            routes: this._config.routes,
            command: this._command,
            pid: this.pid,
            users: this.users,
            isAvailable: this.isAvailable,
            isRemote: this.isRemote,
            isFree: this.isFree,
            isUsing: this.isUsing,
            isFault: this.isFault
        };
    }

    async kill(): Promise<void> {
        await this._kill(true);
    }

    async startStream(user: User, stream: common.StreamSink, channel?: ChannelItem): Promise<void> {
        log.debug("TunerDevice#%d start stream for user `%s` (priority=%d)...", this._index, user.id, user.priority);

        if (this._isAvailable === false) {
            throw new Error(util.format("TunerDevice#%d is not available", this._index));
        }

        if (!channel && !this._isRunning) {
            throw new Error(util.format("TunerDevice#%d has not stream", this._index));
        }

        let spawning: Promise<void> = null;
        if (channel) {
            if (this._config.types.includes(channel.type) === false) {
                throw new Error(util.format("TunerDevice#%d is not supported for channel type `%s`", this._index, channel.type));
            }

            // the remote Mirakurun outputs a relative stream of TSMF for each request
            const relTs = this._isRemote ? user.streamSetting?.tsmfRelTs : undefined;
            // the format to receive (the remote Mirakurun outputs it)
            const format = this._isRemote ? user.streamSetting?.format : undefined;
            if (this._isRunning) {
                if (channel.channel !== this._channel.channel || relTs !== this._remoteRelTs || (format !== undefined && format !== this._remoteFormat)) {
                    if (user.priority <= this.getPriority()) {
                        throw new Error(util.format("TunerDevice#%d has higher priority user", this._index));
                    }

                    this._clearEndStreamTimer();
                    await this._kill(true);
                    spawning = this._spawn(channel, relTs, format);
                }
            } else {
                spawning = this._spawn(channel, relTs, format);
            }
        }

        log.info("TunerDevice#%d streaming to user `%s` (priority=%d)", this._index, user.id, user.priority);

        this._clearEndStreamTimer();
        user._stream = stream;
        this._users.add(user);
        if (stream.closed === true) {
            this.endStream(user);
        } else {
            stream.once("close", () => this.endStream(user));
        }

        this._updated();

        // DVB デバイスを直接選局する間に、ユーザーのいないチューナーとして他の要求に横取りされないよう、ユーザーを加えてから待つ
        if (spawning !== null) {
            try {
                await spawning;
            } catch (err) {
                if (this._users.has(user)) {
                    this.endStream(user);
                }
                throw err;
            }
        }
    }

    endStream(user: User): void {
        log.debug("TunerDevice#%d end stream for user `%s` (priority=%d)...", this._index, user.id, user.priority);

        user._stream.end();
        this._users.delete(user);

        if (this._users.size === 0) {
            // 他のユーザーが使い始めた後に、前のタイマーでチューナーを止めないよう 1 つだけ保持する
            this._clearEndStreamTimer();
            this._endStreamTimer = setTimeout(() => {
                this._endStreamTimer = null;
                if (this._users.size === 0 && this._isRunning) {
                    this._kill(true).catch(log.error);
                }
            }, END_STREAM_DELAY);
        }

        log.info("TunerDevice#%d end streaming to user `%s` (priority=%d)", this._index, user.id, user.priority);

        this._updated();
    }

    async getRemotePrograms(query?: ProgramsQuery): Promise<apid.Program[]> {
        if (!this._isRemote) {
            throw new Error(util.format("TunerDevice#%d is not remote device", this._index));
        }

        const client = new Client();
        client.host = this.config.remoteMirakurunHost;
        client.port = this.config.remoteMirakurunPort || 40772;
        client.userAgent = "Mirakurun (Remote)";

        log.debug("TunerDevice#%d fetching remote programs from %s:%d...", this._index, client.host, client.port);

        const programs = await client.getPrograms(query);

        log.info("TunerDevice#%d fetched %d remote programs", this._index, programs.length);

        return programs;
    }

    async getRemoteChannel(type: apid.ChannelType, channel: string): Promise<apid.Channel> {
        if (!this._isRemote) {
            throw new Error(util.format("TunerDevice#%d is not remote device", this._index));
        }

        return this._getRemoteClient().getChannel(type, channel);
    }

    /** the remote Mirakurun outputs the relative stream of TSMF detected of the channel (not refused for a while) */
    canReceiveRemoteRelTs(channel: ChannelItem, relTs: number): boolean {
        const refusedAt = this._remoteRelTsRefused.get(`${channel.type}/${channel.channel}/${relTs}`);
        return this.supportsRemoteRelTs && (refusedAt === undefined || Date.now() - refusedAt >= REMOTE_REFUSED_RELTS_PERIOD);
    }

    /** the relative stream of the channel reported by the remote Mirakurun is requested again */
    clearRemoteRelTsRefused(channel: ChannelItem, relTs: number): void {
        this._remoteRelTsRefused.delete(`${channel.type}/${channel.channel}/${relTs}`);
    }

    /** checked by `checkRemoteChannelRelTs()` for a while */
    isRemoteChannelRelTsChecked(channel: ChannelItem, relTs: number): boolean {
        const checkedAt = this._remoteChannelRelTsCheckedAt.get(`${channel.type}/${channel.channel}/${relTs}`);
        return checkedAt !== undefined && Date.now() - checkedAt < REMOTE_CHANNEL_RELTS_CHECK_INTERVAL;
    }

    /**
     * checks whether the remote Mirakurun has detected the relative streams of the channel
     * (`tsmfRelTs` of the services of the channel, or `tsmfRelTs` of its channels.yml),
     * not requested for a while if not detected (refused: an empty stream), requested if not known (such as failed to get, or no services yet).
     * The relative stream without the services registered may be detected (refused by the remote Mirakurun if not, not requested for a while)
     */
    async checkRemoteChannelRelTs(channel: ChannelItem, relTs: number): Promise<boolean> {
        const key = `${channel.type}/${channel.channel}/${relTs}`;
        let detected: boolean;
        try {
            const remoteChannel = await this.getRemoteChannel(channel.type, channel.channel);
            const services = remoteChannel.services || [];
            detected = remoteChannel.tsmfRelTs === relTs || services.length === 0 || services.some(service => service.tsmfRelTs !== undefined);
        } catch (err) {
            log.debug("TunerDevice#%d failed to get the channel %s/%s of the remote Mirakurun [%s]", this._index, channel.type, channel.channel, err.message);
            detected = true;
        } finally {
            // checked when finished (not to check again while checking)
            this._remoteChannelRelTsCheckedAt.set(key, Date.now());
        }
        if (!detected) {
            log.info("TunerDevice#%d the relative stream %d on %s/%s is not detected by the remote Mirakurun", this._index, relTs, channel.type, channel.channel);
            this._remoteRelTsRefused.set(key, Date.now());
        }
        return detected;
    }

    /**
     * checks whether the remote Mirakurun outputs the relative stream of TSMF detected (by its API docs),
     * checked again after a while if failed (such as not connected)
     */
    async checkRemoteRelTs(): Promise<boolean> {
        if (!this._isRemote) {
            return false;
        }
        if (this._remoteRelTsSupported !== undefined) {
            return this._remoteRelTsSupported;
        }
        if (this._remoteRelTsChecking === null) {
            this._remoteRelTsChecking = this._getRemoteClient().supportsChannelStreamTsmfRelTs()
                .then(supported => {
                    // not overwritten by the result of lib/remote
                    this._remoteRelTsSupported ??= supported;
                    this._remoteRelTsCheckFailed = false;
                    log.info("TunerDevice#%d the remote Mirakurun %s the relative stream of TSMF detected", this._index, supported ? "supports" : "does not support");
                    if (this._remoteRelTsSupported === false) {
                        // checked again (the remote Mirakurun may be updated)
                        this._scheduleRemoteRelTsCheck(REMOTE_RELTS_RECHECK_INTERVAL);
                    }
                    return this._remoteRelTsSupported;
                })
                .catch(err => {
                    // logged once until checked
                    log[this._remoteRelTsCheckFailed ? "debug" : "warn"]("TunerDevice#%d failed to check the remote Mirakurun [%s]", this._index, err.message);
                    this._remoteRelTsCheckFailed = true;
                    this._scheduleRemoteRelTsCheck(REMOTE_RELTS_CHECK_INTERVAL);
                    return false;
                })
                .finally(() => {
                    this._remoteRelTsChecking = null;
                });
        }
        return this._remoteRelTsChecking;
    }

    /** checks again after `delay` (not supported is checked again too) */
    private _scheduleRemoteRelTsCheck(delay: number): void {
        if (this._remoteRelTsRetryTimer !== null) {
            return;
        }
        this._remoteRelTsRetryTimer = setTimeout(() => {
            this._remoteRelTsRetryTimer = null;
            if (this._remoteRelTsSupported === false) {
                this._remoteRelTsSupported = undefined;
            }
            this.checkRemoteRelTs();
        }, delay);
        this._remoteRelTsRetryTimer.unref?.();
    }

    private _getRemoteClient(): Client {
        const client = new Client();
        client.host = this.config.remoteMirakurunHost;
        client.port = this.config.remoteMirakurunPort || 40772;
        client.userAgent = "Mirakurun (Remote)";
        return client;
    }

    private _clearEndStreamTimer(): void {
        clearTimeout(this._endStreamTimer);
        this._endStreamTimer = null;
    }

    /** dvbv5-zap のコマンドを解釈できる場合は、DVB デバイスを直接操作する */
    private _initDvb(): void {
        let options: ReturnType<typeof parseDvbv5ZapCommand>;
        let confPathByRoute: Partial<Record<apid.ChannelRoute, string>> = null;
        try {
            if (this._config.command && this._config.command.includes("<route>")) {
                // 経路ごとのコマンドを解釈する (チャンネル設定ファイル以外は同じでなければならない)
                confPathByRoute = {};
                for (const route of this._config.routes || common.channelRoutes) {
                    const routeOptions = parseDvbv5ZapCommand(
                        this._config.command.replace(/<route>/g, route.toLowerCase()),
                        this._config.dvbDevicePath
                    );
                    if (routeOptions === null) {
                        return;
                    }
                    if (options && JSON.stringify({ ...options, channelsConfPath: null }) !== JSON.stringify({ ...routeOptions, channelsConfPath: null })) {
                        throw new Error("`<route>` is only allowed in `-c`");
                    }
                    // 読めないチャンネル設定ファイルでは選局のたびに失敗するため、先に読んで確かめる
                    loadChannelsConf(routeOptions.channelsConfPath);
                    options = routeOptions;
                    confPathByRoute[route] = routeOptions.channelsConfPath;
                }
            } else {
                options = parseDvbv5ZapCommand(this._config.command, this._config.dvbDevicePath);
                if (options === null) {
                    return;
                }
                // 読めないチャンネル設定ファイルでは選局のたびに失敗するため、先に読んで確かめる
                loadChannelsConf(options.channelsConfPath);
            }
        } catch (err) {
            // dvbv5-zap なのにコマンドを実行する場合は、選局が遅くなるため警告する
            log.warn("TunerDevice#%d uses the command instead of DVB device direct access (%s)", this._index, err.message);
            return;
        }

        const DvbDeviceClass = loadDvbDevice();
        if (DvbDeviceClass === null) {
            return;
        }

        this._dvb = new DvbDeviceClass(options);
        this._dvbChannelsConfPath = options.channelsConfPath;
        this._dvbChannelsConfPathByRoute = confPathByRoute;
        this._dvbChannelByFrequency = options.channelByFrequency;
        this._dvb.on("data", this._streamOnData.bind(this));
        this._dvb.on("overflow", () => {
            log.warn("TunerDevice#%d DVB device buffer overflow", this._index);
        });
        this._dvb.on("error", this._dvbOnError.bind(this));

        log.info("TunerDevice#%d uses DVB device %s directly (frontend=%d, demux=%d)", this._index, this._dvb.path, options.frontend, options.demux);
    }

    /** respawned with the relative stream and the format of the remote Mirakurun as before */
    private async _spawn(ch: ChannelItem, relTs = this._remoteRelTs, format = this._remoteFormat): Promise<void> {
        if (this._dvb !== null) {
            return this._spawnDvb(ch);
        }
        return this._spawnCommand(ch, relTs, format);
    }

    /**
     * @param relTs the relative stream of TSMF the remote Mirakurun outputs
     * @param format the format the remote Mirakurun outputs (the format of the stream filter)
     */
    private async _spawnCommand(ch: ChannelItem, relTs?: number, format?: apid.StreamFormat): Promise<void> {
        log.debug("TunerDevice#%d spawn...", this._index);

        if (this._process) {
            throw new Error(util.format("TunerDevice#%d has process", this._index));
        }

        let cmd: string;

        if (this._isRemote === true) {
            cmd = "node lib/remote";
            cmd += " " + this._config.remoteMirakurunHost;
            cmd += " " + (this._config.remoteMirakurunPort || 40772);
            cmd += " " + ch.type;
            cmd += " " + ch.channel;
            if (this._config.remoteMirakurunDecoder === true) {
                cmd += " decode";
            }
            format = format || (relTs !== undefined ? ch.getFormat(relTs) : ch.remoteFormat);
            if (format === "tlv") {
                cmd += " tlv";
            }
            if (relTs !== undefined) {
                cmd += " relTs=" + relTs;
            }
        } else {
            cmd = this._config.command;
        }

        cmd = common.replaceCommandTemplate(cmd, {
            channel: ch.channel,
            type: ch.type,
            route: (ch.route || common.getDefaultChannelRoute(ch.type)).toLowerCase(),
            satelite: ch.commandVars?.satellite || "", // deprecated, for backward compatibility
            space: 0, // default value for backward compatibility
            ...ch.commandVars
        });

        const parsed = common.parseCommandForSpawn(cmd);

        this._process = child_process.spawn(parsed.command, parsed.args);
        this._spawnedAt = Date.now();
        this._command = cmd;
        this._channel = ch;
        this._remoteRelTs = this._isRemote ? relTs : undefined;
        this._remoteFormat = this._isRemote ? format : undefined;

        if (this._config.dvbDevicePath) {
            const cat = child_process.spawn("cat", [this._config.dvbDevicePath]);

            cat.once("error", (err) => {
                log.error("TunerDevice#%d cat process error `%s` (pid=%d)", this._index, err.name, cat.pid);

                this._kill(false);
            });

            cat.once("close", (code, signal) => {
                log.debug(
                    "TunerDevice#%d cat process has closed with code=%d by signal `%s` (pid=%d)",
                    this._index, code, signal, cat.pid
                );

                if (this._exited === false) {
                    this._kill(false);
                }
            });

            this._process.once("exit", () => cat.kill("SIGKILL"));

            this._stream = cat.stdout;
        } else {
            this._stream = this._process.stdout;
        }

        this._process.once("exit", () => this._exited = true);

        // 起動に失敗した場合は "error" の後に "close" も発生するため、後処理は 1 回だけにする
        let ended = false;
        const end = () => {
            if (ended) {
                return;
            }
            ended = true;
            this._end();
            setTimeout(this._release.bind(this), this._config.dvbDevicePath ? 1000 : 100);
        };

        this._process.once("error", (err) => {
            log.fatal("TunerDevice#%d process error `%s` (pid=%d)", this._index, err.name, this._process.pid);

            ++this._fatalCount;
            if (this._fatalCount >= 3) {
                log.fatal("TunerDevice#%d has something fault! **RESTART REQUIRED** after fix it.", this._index);

                this._isFault = true;
                this._closing = true;
            }
            end();
        });

        this._process.once("close", (code, signal) => {
            log.info(
                "TunerDevice#%d process has closed with exit code=%d by signal `%s` (pid=%d)",
                this._index, code, signal, this._process.pid
            );

            // the request refused by the remote Mirakurun is not respawned (refused again)
            if (this._isRemote === true && code === REMOTE_REFUSED_EXIT_CODE && this._closing === false) {
                log.warn("TunerDevice#%d the remote Mirakurun has refused the request, closing the streams", this._index);
                this._closing = true;
                // the relative stream detected (such as not detected by the remote Mirakurun) is not requested for a while
                if (this._remoteRelTs !== undefined && this._channel) {
                    this._remoteRelTsRefused.set(`${this._channel.type}/${this._channel.channel}/${this._remoteRelTs}`, Date.now());
                }
            }
            // the remote Mirakurun outputs the stream of the channel for the relative stream detected (not used for it)
            if (this._isRemote === true && code === REMOTE_RELTS_UNSUPPORTED_EXIT_CODE && this._closing === false) {
                log.warn("TunerDevice#%d the remote Mirakurun does not support the relative stream of TSMF detected, closing the streams", this._index);
                this._remoteRelTsSupported = false;
                this._scheduleRemoteRelTsCheck(REMOTE_RELTS_RECHECK_INTERVAL);
                this._closing = true;
            }

            end();
        });

        this._process.stderr.on("data", data => {
            log.debug("TunerDevice#%d > %s", this._index, data.toString().trim());
        });

        // flowing start
        this._stream.on("data", this._streamOnData.bind(this));

        this._updated();
        log.info("TunerDevice#%d process has spawned by command `%s` (pid=%d)", this._index, cmd, this._process.pid);
    }

    private async _spawnDvb(ch: ChannelItem): Promise<void> {
        log.debug("TunerDevice#%d tune...", this._index);

        if (this._dvbActive) {
            throw new Error(util.format("TunerDevice#%d has stream", this._index));
        }

        clearTimeout(this._dvbCloseTimer);
        this._dvbCloseTimer = null;

        this._dvbActive = true;
        this._command = `${this._dvb.path} ${ch.channel}`;
        this._channel = ch;
        this._spawnedAt = Date.now();
        this._updated();

        const generation = ++this._dvbGeneration;
        const channelsConfPath = this._dvbChannelsConfPathByRoute
            ? this._dvbChannelsConfPathByRoute[ch.route || common.getDefaultChannelRoute(ch.type)]
            : this._dvbChannelsConfPath;
        let channels: DvbChannels;
        try {
            channels = await readChannelsConf(channelsConfPath);
        } catch (err) {
            // 起動後にチャンネル設定ファイルを読めなくなった場合は、その選局だけコマンドを実行する (次の選局で読み直す)
            return this._spawnCommandInsteadOfDvb(ch, generation, err);
        }

        try {
            // 設定を読む間に止めた場合は、止めた側で後処理している
            if (generation !== this._dvbGeneration) {
                return;
            }
            await this._dvb.start(findChannelParams(channels, ch.channel, channelsConfPath, this._dvbChannelByFrequency));
        } catch (err) {
            // 選局の途中で止めた場合は、止めた側で後処理している
            if (generation === this._dvbGeneration) {
                log.error("TunerDevice#%d failed to tune by DVB device `%s`", this._index, err.message);

                // コマンドを起動できない場合と同じく、デバイスがない場合だけ数える
                if (err.syscall === "open" && DVB_MISSING_DEVICE_ERRORS.includes(err.code)) {
                    ++this._fatalCount;
                    if (this._fatalCount >= 3) {
                        log.fatal("TunerDevice#%d has something fault! **RESTART REQUIRED** after fix it.", this._index);
                        this._isFault = true;
                    }
                } else {
                    this._fatalCount = 0;
                }

                // 選局の間に合流したユーザーも終了させる
                ++this._dvbGeneration;
                this._closing = true;
                this._end();
                await this._dvb.close().catch(log.error);
                this._release();
            }
            throw err;
        }

        if (generation === this._dvbGeneration) {
            this._fatalCount = 0;
            log.info("TunerDevice#%d has tuned by DVB device %s (channel=%s) in %dms", this._index, this._dvb.path, ch.channel, Date.now() - this._spawnedAt);
        }
    }

    private async _spawnCommandInsteadOfDvb(ch: ChannelItem, generation: number, err: Error): Promise<void> {
        // 設定を読む間に止めた場合は、止めた側で後処理している (後から始めた選局の frontend を閉じないよう、閉じる前に確かめる)
        if (generation !== this._dvbGeneration) {
            return;
        }
        log.warn("TunerDevice#%d uses the command for this tuning because the channels file can not be used (%s)", this._index, err.message);
        // コマンドが DVB デバイスを開けるよう、frontend を閉じる
        await this._dvb.close().catch(log.error);
        // 閉じる間に止めた場合は、止めた側で後処理している
        if (generation !== this._dvbGeneration) {
            return;
        }

        this._dvbActive = false;
        try {
            await this._spawnCommand(ch);
        } catch (err) {
            // 選局に失敗した場合と同じく、選局の間に合流したユーザーも終了させる
            this._closing = true;
            this._end();
            this._release();
            throw err;
        }
    }

    private _dvbOnError(err: Error): void {
        log.error("TunerDevice#%d DVB device read error `%s`", this._index, err.message);

        // 止めている途中であれば、止めた側で後処理している
        if (this._dvbActive === false || this._closing === true) {
            return;
        }

        // 開き直して選局し直す (ユーザーが残っている場合)
        const generation = ++this._dvbGeneration;
        this._isAvailable = false;
        this._updated();
        this._dvb.close().catch(log.error).then(() => {
            // 閉じる間に止めた場合は、止めた側で後処理している
            if (generation !== this._dvbGeneration) {
                return;
            }
            this._end();

            // 読み出しに失敗し続ける場合に、待たずに選局し直し続けないよう、待ってから選局し直す
            setTimeout(() => {
                // 待つ間に止めた場合は、止めた側で後処理している
                if (generation !== this._dvbGeneration) {
                    return;
                }
                this._release();
            }, DVB_RESPAWN_DELAY);
        });
    }

    private _streamOnData(chunk: Buffer): void {
        if (this._spawnedAt !== 0) {
            log.debug("TunerDevice#%d received first data in %dms after spawn", this._index, Date.now() - this._spawnedAt);
            this._spawnedAt = 0;
        }

        // 入力のたびに書き出さず、全ストリームの出力をまとめて書き出す (書き出しの回数を減らすため)
        // (選局や合流の直後に最初の出力を遅らせないよう、出力を始めるまでは TSFilter がすぐに書き出す)
        for (const user of this._users) {
            user._stream.write(chunk, true);
        }

        this._pendingBytes += chunk.length;
        if (this._pendingBytes >= FLUSH_BYTES) {
            this._flushUsers();
        } else if (this._flushTimer === null) {
            this._flushTimer = setTimeout(this._flushUsersBound, FLUSH_INTERVAL);
        }
    }

    private _flushUsers(): void {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
        this._pendingBytes = 0;

        for (const user of this._users) {
            user._stream.flush();
        }
    }

    private _end(): void {
        this._flushUsers();

        this._isAvailable = false;

        this._stream?.removeAllListeners("data");

        if (this._closing === true) {
            for (const user of this._users) {
                user._stream.end();
            }
            this._users.clear();
        }

        this._updated();
    }

    private async _kill(close: boolean): Promise<void> {
        log.debug("TunerDevice#%d kill...", this._index);

        if (this._dvbActive === false && (!this._process || !this._process.pid)) {
            throw new Error(util.format("TunerDevice#%d has not process", this._index));
        } else if (this._closing) {
            log.debug("TunerDevice#%d return because it is closing", this._index);
            return;
        }

        this._isAvailable = false;
        this._closing = close;

        this._updated();

        const killedAt = Date.now();
        if (this._dvbActive) {
            // 選局し直す場合に備えて、frontend は開いたまま配信だけを止める
            ++this._dvbGeneration;
            await this._dvb.stopStream().catch(log.error);
            this._end();
            this._release();
            log.debug("TunerDevice#%d released in %dms after kill", this._index, Date.now() - killedAt);
            return;
        }

        await new Promise<void>(resolve => {
            this.once("release", resolve);

            if (/^dvbv5-zap /.test(this._command) === true) {
                this._process.kill("SIGKILL");
            } else {
                const timer = setTimeout(() => {
                    log.warn("TunerDevice#%d will force killed because SIGTERM timed out...", this._index);
                    this._process.kill("SIGKILL");
                }, 6000);
                this._process.once("exit", () => clearTimeout(timer));

                // regular way
                this._process.kill("SIGTERM");
            }
        });
        log.debug("TunerDevice#%d released in %dms after kill", this._index, Date.now() - killedAt);
    }

    private _release(): void {
        if (this._process) {
            this._process.stderr.removeAllListeners();
            this._process.removeAllListeners();
        }
        if (this._stream) {
            this._stream.removeAllListeners();
        }

        const dvbReleased = this._dvbActive;
        this._command = null;
        this._process = null;
        this._stream = null;
        this._dvbActive = false;

        if (this._closing === false && this._users.size !== 0) {
            log.warn("TunerDevice#%d respawning because request has not closed", this._index);
            ++status.errorCount.tunerDeviceRespawn;

            // 残ったユーザーが使い続けるため、_end() で使用不可にしたチューナーを戻す (他のユーザーも合流できるように)
            if (this._isFault === false) {
                this._isAvailable = true;
            }

            this._spawn(this._channel).catch(err => {
                log.error("TunerDevice#%d respawn failed `%s`", this._index, err.message);

                // DVB デバイスの選局に失敗した場合は _spawnDvb() の中で後処理しているため、コマンドを起動できずにユーザーが残った場合だけ終了させる
                if (this._isRunning === false && this._users.size !== 0 && this._closing === false) {
                    this._closing = true;
                    this._end();
                    this._release();
                }
            });
            return;
        }

        // DVB デバイスを直接操作する場合は、選局に成功した時点で戻す (選局の失敗を数え続けるため)
        if (dvbReleased === false) {
            this._fatalCount = 0;
        }
        this._channel = null;
        this._remoteRelTs = undefined;
        this._remoteFormat = undefined;
        this._users.clear();

        if (this._isFault === false) {
            this._isAvailable = true;
        }

        this._closing = false;
        this._exited = false;

        if (this._dvb !== null && this._dvb.isOpen) {
            clearTimeout(this._dvbCloseTimer);
            this._dvbCloseTimer = setTimeout(() => {
                this._dvbCloseTimer = null;
                if (this._dvbActive === false) {
                    this._dvb.close().catch(log.error);
                }
            }, DVB_CLOSE_DELAY);
        }

        this.emit("release");

        log.info("TunerDevice#%d released", this._index);

        this._updated();
    }

    private _updated(): void {
        Event.emit("tuner", "update", this.toJSON());
    }
}
