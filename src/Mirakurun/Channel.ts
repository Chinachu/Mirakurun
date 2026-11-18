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
import * as common from "./common";
import * as log from "./log";
import * as apid from "../../api";
import _ from "./_";
import * as db from "./db";
import status from "./status";
import ChannelItem, { ChannelStream } from "./ChannelItem";
import type ServiceItem from "./ServiceItem";
import { JobItem } from "./Job";

export interface StreamLocation {
    channel: ChannelItem;
    /** `null` until the stream is received on the channel */
    stream: ChannelStream | null;
}

export class Channel {
    private _items: ChannelItem[] = [];
    private _startup: boolean = true;
    private _saveTimerId: NodeJS.Timeout;
    private _streams = new Map<ChannelItem, ChannelStream[]>();
    private _unloadedChannels: db.Channel[] = [];
    /** <networkId, <streamId, the channels and the streams>> */
    private _streamIndex: Map<number, Map<number, StreamLocation[]>> = null;

    constructor() {
        this._load();

        if (_.config.server.disableEITParsing !== true) {
            const epgJob: JobItem = {
                key: "EPG.Gatherer",
                name: "EPG Gatherer",
                fn: () => this._epgGatherer()
            };

            _.job.add({
                ...epgJob,
                readyFn: async () => {
                    await common.sleep(1000 * 60);
                    return true;
                }
            });

            _.job.addSchedule({
                key: epgJob.key,
                schedule: _.config.server.epgGatheringJobSchedule || "20,50 * * * *",
                job: epgJob
            });
        }
    }

    get items(): ChannelItem[] {
        return this._items;
    }

    add(item: ChannelItem): void {
        if (this.get(item.type, item.channel) === null) {
            this._items.push(item);
            this._streamIndex = null;
            _.service?.invalidateChannelIndex?.();
        }
    }

    get(type: apid.ChannelType, channel: string): ChannelItem {
        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].channel === channel && this._items[i].type === type) {
                return this._items[i];
            }
        }

        return null;
    }

    findByType(type: apid.ChannelType): ChannelItem[] {
        const items = [];

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].type === type) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    /** channels received the stream last time */
    findByStream(networkId: number, streamId: number): ChannelItem[] {
        return [...new Set(this.findStreamLocations(networkId, streamId).map(location => location.channel))];
    }

    /** the channels and the streams (the relative streams of TSMF) received the stream last time */
    findStreamLocations(networkId: number, streamId: number): StreamLocation[] {
        if (this._streamIndex === null) {
            this._streamIndex = new Map();
            for (const item of this._items) {
                for (const stream of this._streams.get(item) || []) {
                    let streams = this._streamIndex.get(stream.networkId);
                    if (!streams) {
                        streams = new Map();
                        this._streamIndex.set(stream.networkId, streams);
                    }
                    let locations = streams.get(stream.streamId);
                    if (!locations) {
                        locations = [];
                        streams.set(stream.streamId, locations);
                    }
                    locations.push({ channel: item, stream });
                }
            }
        }

        return this._streamIndex.get(networkId)?.get(streamId) || [];
    }

    getStreams(item: ChannelItem): ChannelStream[] {
        return this._streams.get(item) || [];
    }

    setStreams(item: ChannelItem, streams: ChannelStream[]): void {
        if (JSON.stringify(this._streams.get(item) || []) === JSON.stringify(streams)) {
            return;
        }
        this._streams.set(item, streams);
        this._streamIndex = null;
        _.service?.invalidateChannelIndex?.();

        this.save();
    }

    save(): void {
        clearTimeout(this._saveTimerId);
        this._saveTimerId = setTimeout(() => this._save(), 1000 * 10);
    }

    async load(): Promise<void> {
        log.debug("loading channels db...");

        const channels = await db.loadChannels(_.configIntegrity.channels, true);
        this._unloadedChannels = [];
        const unloaded = new Map<apid.ConfigChannelsItem, typeof channels[number]>();
        const currentItems = new Map(this._items.map(item => [`${item.type}/${item.channel}`, item]));
        const currentConfigs = new Map<string, apid.ConfigChannelsItem[]>();
        for (const config of _.config.channels) {
            const key = `${config.type}/${config.channel}`;
            const rows = currentConfigs.get(key);
            if (rows) { rows.push(config); } else { currentConfigs.set(key, [config]); }
        }
        let changedInputs = 0;
        let upgrade = false;
        for (const channel of channels) {
            const key = `${channel.type}/${channel.channel}`;
            const item = currentItems.get(key) || null;
            if (item === null && channel.reception === undefined) {
                const configs = currentConfigs.get(key) || [];
                const first = configs[0];
                if (first && configs.some(config => !db.channelStateMatches({ ...channel, reception: db.channelStateReception(first) }, config))) {
                    // 旧形式には経路の証拠がない。稼働入力も一意の設定もない場合は先頭行へ認定せず、元データを保持する。
                    unloaded.set(first, channel);
                    continue;
                }
            }
            if (item === null || !db.channelStateMatches(channel, item.toJSON())) {
                const configured = currentConfigs.get(key)?.find(config => db.channelStateMatches(channel, config));
                if (configured) {
                    // 無効化やチューナー未接続中の行も保持し、ほかの経路の保存で消さない。
                    unloaded.set(configured, { ...channel, reception: db.channelStateReception(configured) });
                    upgrade ||= channel.reception === undefined;
                } else if (item !== null) { ++changedInputs; }
                continue;
            }
            upgrade ||= channel.reception === undefined;
            // the format before the relative streams of TSMF (the stream of the channel, of `tsmfRelTs` if specified)
            const legacy = channel as unknown as db.ChannelStream;
            const streams = Array.isArray(channel.streams) ? channel.streams : [{ ...legacy, relTs: item.tsmfRelTs || undefined }];
            item.setStreams(streams
                .filter(stream => typeof stream.networkId === "number" && typeof stream.streamId === "number")
                .map(stream => ({
                    networkId: stream.networkId,
                    streamId: stream.streamId,
                    ...((stream.format === "ts" || stream.format === "tlv") && { format: stream.format }),
                    ...(typeof stream.relTs === "number" && { relTs: stream.relTs }),
                    ...(typeof stream.slots === "number" && { slots: stream.slots }),
                    ...(stream.remote === true && { remote: true }),
                    ...(Number.isInteger(stream.groupId) && stream.groupId >= 0 && stream.groupId <= 255 &&
                        Number.isInteger(stream.numberOfCarriers) && stream.numberOfCarriers > 1 && stream.numberOfCarriers <= 255 &&
                        Number.isInteger(stream.carrierSequence) && stream.carrierSequence >= 0 && stream.carrierSequence <= stream.numberOfCarriers &&
                        { groupId: stream.groupId, numberOfCarriers: stream.numberOfCarriers, carrierSequence: stream.carrierSequence,
                            ...(Number.isInteger(stream.tsmfNetworkId) && Number.isInteger(stream.tsmfStreamId) && { tsmfNetworkId: stream.tsmfNetworkId, tsmfStreamId: stream.tsmfStreamId }) })
                })));
        }
        this._unloadedChannels = [...unloaded.values()];
        if (changedInputs > 0) { log.warn("保存時と受信設定が異なる%d件の経路を再スキャンします。", changedInputs); }
        clearTimeout(this._saveTimerId);
        // integrity一致の旧形式を現在の受信設定付きに移し、次の小変更で再び破棄しない。
        // 旧JSONの通常のI/O失敗はdb.saveがログへ記録するbest-effort契約を維持する。
        if (upgrade) { await this._save(); }
    }

    private _save(): Promise<void> {
        log.debug("saving channels db...");

        const currentConfigs = new Map(this._items.map(item => [`${item.type}/${item.channel}`, item.toJSON()]));
        return db.saveChannels(
            [
                ...this._items.filter(item => this.getStreams(item).length > 0).map(item => ({
                    type: item.type, channel: item.channel, reception: db.channelStateReception(item.toJSON()), streams: this.getStreams(item)
                })),
                // 稼働中の入力でsetStreams([])となった結果を、古い保留行で復活させない。
                ...this._unloadedChannels.filter(record => {
                    const current = currentConfigs.get(`${record.type}/${record.channel}`);
                    return !current || !db.channelStateMatches(record, current);
                })
            ],
            _.configIntegrity.channels
        );
    }

    private _load(): void {
        log.debug("loading channels...");

        const channels = _.config.channels;

        channels.forEach((channel, i) => {
            if (typeof channel.name !== "string") {
                log.error("invalid type of property `name` in channel#%d configuration", i);
                return;
            }

            if (common.channelTypes.includes(channel.type) === false) {
                log.error("invalid type of property `type` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (typeof channel.channel !== "string") {
                log.error("invalid type of property `channel` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.format !== undefined && channel.format !== "ts" && channel.format !== "tlv") {
                log.error("invalid type of property `format` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.route !== undefined && common.channelRoutes.includes(channel.route) === false) {
                log.error("invalid type of property `route` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.serviceId && typeof channel.serviceId !== "number") {
                log.error("invalid type of property `serviceId` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.tsmfGroupId !== undefined && (Number.isInteger(channel.tsmfGroupId) === false || channel.tsmfGroupId < 1 || channel.tsmfGroupId > 255)) {
                log.error("invalid type of property `tsmfGroupId` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            // 旧設定の0・null・空文字は未指定として読み込む。APIからの新規保存は1〜15に限定する。
            const relTs: unknown = channel.tsmfRelTs;
            const unspecifiedRelTs = relTs === undefined || relTs === 0 || relTs === null || relTs === "";
            if (!unspecifiedRelTs && (typeof relTs !== "number" || !Number.isInteger(relTs) || relTs < 1 || relTs > 15)) {
                log.error("channel#%d (%s) の tsmfRelTs は1〜15の整数で指定してください。", i, channel.name);
                return;
            }

            if (channel.commandVars && typeof channel.commandVars !== "object") {
                log.error("invalid type of property `commandVars` in channel#%d (%s) configuration", i, channel.name);
                return;
            }
            if (!channel.commandVars) {
                channel.commandVars = {};
            }
            if (channel.satelite && !channel.satellite) {
                log.warn("renaming deprecated property name `satelite` to `satellite` in channel#%d (%s) configuration", i, channel.name);
                (<any> channel).satellite = channel.satelite;
            }
            if (channel.satellite) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.satellite) {
                    channel.commandVars.satellite = channel.satellite;
                }
            }
            if (channel.space) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.space) {
                    channel.commandVars.space = channel.space;
                }
            }
            if (channel.freq) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.freq) {
                    channel.commandVars.freq = channel.freq;
                }
            }
            if (channel.polarity) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.polarity) {
                    channel.commandVars.polarity = channel.polarity;
                }
            }
            for (const key in channel.commandVars) {
                if (typeof channel.commandVars[key] !== "number" && typeof channel.commandVars[key] !== "string") {
                    log.error("invalid type of property `commandVars.%s` in channel#%d (%s) configuration", key, i, channel.name);
                    delete channel.commandVars[key];
                }
            }

            if (channel.isDisabled === true) {
                return;
            }

            if (_.tuner.typeExists(channel.type, channel.route || common.getDefaultChannelRoute(channel.type)) === false) {
                return;
            }

            const existing = this.get(channel.type, channel.channel);
            const route = channel.route || common.getDefaultChannelRoute(channel.type);
            if (existing && existing.route !== route) {
                log.warn("%s/%s は経路 %s で先に設定されているため、channel#%d の経路 %s の行を読み込みません。", channel.type, channel.channel, existing.route, i, route);
            }
            if (!existing) {
                if (channel.serviceId) {
                    (<any> channel).name = `${channel.type}:${channel.channel}`;
                }
                this.add(new ChannelItem(unspecifiedRelTs ? { ...channel, tsmfRelTs: undefined } : channel));
            }
        });
    }

    private async _epgGatherer(): Promise<void> {
        const startup = this._startup;
        if (this._startup === true) {
            this._startup = false;
        }

        // EIT of TS carries the whole network, MH-EIT of TLV (MMT) carries only its own stream
        const targets = new Map<string, { label: string, networkId: number, streamId?: number, services: ServiceItem[] }>();
        for (const item of _.service.items) {
            const isTlv = item.isTlv;
            // 旧サービスのstreamId未確定時は、再スキャンまで既定の相対TSで取得を試す。
            // ID未確認の間は別TLVを除外しないよう、同じネットワークの既知IDのジョブへ統合しない。
            // 同じTLVの取得を確認できた時点で重複を避けるため、最初のMH-EIT受信前は並行する場合がある。
            const key = isTlv ? `NID.${item.networkId}.TSID.${item.streamId ?? "unknown"}` : `NID.${item.networkId}`;
            if (!targets.has(key)) {
                targets.set(key, {
                    label: isTlv && item.streamId === undefined ? `Network#${item.networkId}（ストリーム未確認）`
                        : isTlv ? `Network#${item.networkId} Stream#${item.streamId}` : `Network#${item.networkId}`,
                    networkId: item.networkId,
                    streamId: isTlv ? item.streamId : undefined,
                    services: []
                });
            }
            targets.get(key).services.push(item);
        }

        for (const [key, { label, networkId, streamId, services }] of targets) {
            const service = services[0];

            // any channel of the network can be used, the first service's ones come first
            // the channels and the relative streams of TSMF (MH-EIT of TLV needs the relative stream of the stream)
            const locations = [service, ...services].flatMap(item => item.locations);
            const channels = [...new Set(locations.map(location => location.channel))];
            if (channels.length === 0) {
                continue;
            }
            const targets = channels.map(channel => {
                const { stream } = locations.find(location => location.channel === channel);
                return { channel, relTs: stream ? stream.relTs : channel.getDefaultRelTs(networkId) };
            });
            const isGathering = () => {
                if (streamId !== undefined) {
                    return status.epgByStream[common.getEpgStreamKey(networkId, streamId)] === true;
                }
                if (status.epg[networkId] === true) { return true; }
                if (!service.isTlv) { return false; }
                // 未確定サービスもTLVの所有権を見る。全候補の既定入力を同じTLVと確認できる場合だけ、
                // そのstreamに限定し、別TLVの通常取得を妨げない。Serviceの未確定IDは書き換えない。
                const streams = targets.map(target => target.channel.getStreamByRelTs(target.relTs));
                const first = streams[0];
                if (first?.networkId === networkId && first.streamId !== undefined && first.format === "tlv" &&
                    streams.every(stream => stream?.networkId === networkId && stream.streamId === first.streamId && stream.format === "tlv")) {
                    return status.epgByStream[common.getEpgStreamKey(networkId, first.streamId)] === true;
                }
                const prefix = `${networkId}/`;
                return Object.keys(status.epgByStream).some(key => key.startsWith(prefix) && status.epgByStream[key] === true);
            };
            // picked by readyFn
            let channel: ChannelItem = null;

            _.job.add({
                key: `EPG.Gather.${key}`,
                name: `EPG Gather ${label}`,
                isRerunnable: true,
                fn: async () => {
                    log.info("%s EPG gathering has started on %s/%s", label, channel.type, channel.channel);
                    try {
                        await _.tuner.getEPG(channel, undefined, targets.find(target => target.channel === channel).relTs);
                        log.info("%s EPG gathering has finished", label);
                    } catch (e) {
                        log.warn("%s EPG gathering has failed [%s]", label, e);
                        throw new Error("EPG gathering failed");
                    }
                },
                readyFn: async () => {
                    await common.sleep(100);

                    if (isGathering()) {
                        log.info("%s EPG gathering is already in progress on another stream", label);
                        return false;
                    }
                    if (service.epgReady === true) {
                        const now = Date.now();
                        if (startup && now - service.epgUpdatedAt < 1000 * 60 * 10) { // 10 mins
                            log.info("%s EPG gathering has skipped because EPG is already up to date (in 10 mins)", label);
                            return false;
                        }
                        if (now - service.epgUpdatedAt > 1000 * 60 * 60 * 12) { // 12 hours
                            log.info("%s EPG gathering is resuming forcibly because reached maximum pause time (12 hours)", label);
                            service.epgReady = false;
                        } else {
                            // この版の番組ストアはインメモリのため、取得済みの同ネットワークから対象ストリームを絞る。
                            // TLVはstreamId未確定でも対象サービスに限定し、同じnetworkIdの別TLVで休止を判定しない。
                            // TSのEITはネットワーク全体を含むため、従来どおりサービスでは絞らない。
                            const serviceIds = service.isTlv ? services.map(item => item.serviceId) : undefined;
                            const isTarget = (program: { serviceId: number }) => serviceIds === undefined || serviceIds.includes(program.serviceId);
                            const currentPrograms = _.program.findByNetworkIdAndTime(networkId, now)
                                .filter(program => !!program.name && program.name !== "放送休止" && isTarget(program));
                            if (currentPrograms.length === 0) {
                                const networkPrograms = _.program.findByNetworkId(networkId).filter(isTarget);
                                if (networkPrograms.length > 0) {
                                    log.info("%s EPG gathering has skipped because broadcast is off", label);
                                    return false;
                                }
                                service.epgReady = false;
                            }
                        }
                    }

                    channel = await _.tuner.readyForJob(targets);
                    // 照会待ちの間に別filterが取得を始めた場合も、重複した取得を開始しない。
                    return channel !== null && !isGathering();
                }
            });
        }
    }
}

export default Channel;
