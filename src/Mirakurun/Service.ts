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
import { join, dirname } from "path";
import { existsSync } from "fs";
import { stat, mkdir, readFile, writeFile } from "fs/promises";
import { sleep, getDefaultChannelRoute } from "./common";
import * as log from "./log";
import * as db from "./db";
import _ from "./_";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";

const { LOGO_DATA_DIR_PATH } = process.env;

export class Service {
    static getLogoDataPath(networkId: number, logoId: number) {
        if (typeof logoId !== "number" || logoId < 0) {
            throw new Error("Invalid `logoId`");
        }

        return join(LOGO_DATA_DIR_PATH, `${networkId}_${logoId}.png`);
    }

    static async getLogoDataMTime(networkId: number, logoId: number): Promise<number> {
        if (typeof logoId !== "number" || logoId < 0) {
            return 0;
        }

        try {
            return (await stat(Service.getLogoDataPath(networkId, logoId))).mtimeMs;
        } catch (e) {
            return 0;
        }
    }

    static async isLogoDataExists(networkId: number, logoId: number): Promise<boolean> {
        if (typeof logoId !== "number" || logoId < 0) {
            return false;
        }

        try {
            return (await stat(Service.getLogoDataPath(networkId, logoId))).isFile();
        } catch (e) {
            return false;
        }
    }

    static async loadLogoData(networkId: number, logoId: number): Promise<Buffer> {
        if (typeof logoId !== "number" || logoId < 0) {
            return null;
        }

        try {
            return await readFile(Service.getLogoDataPath(networkId, logoId));
        } catch (e) {
            return null;
        }
    }

    static async saveLogoData(networkId: number, logoId: number, data: Uint8Array, retrying = false): Promise<void> {
        log.info("Service.saveLogoData(): saving... (networkId=%d logoId=%d)", networkId, logoId);

        const path = Service.getLogoDataPath(networkId, logoId);

        try {
            await writeFile(path, data, { encoding: "binary" });
        } catch (e) {
            if (retrying === false) {
                // mkdir if not exists
                const dirPath = dirname(path);
                if (existsSync(dirPath) === false) {
                    log.warn("Service.saveLogoData(): making directory `%s`... (networkId=%d logoId=%d)", dirPath, networkId, logoId);
                    try {
                        await mkdir(dirPath, { recursive: true });
                    } catch (e) {
                        throw e;
                    }
                }
                // retry
                log.warn("Service.saveLogoData(): retrying... (networkId=%d logoId=%d)", networkId, logoId);
                return this.saveLogoData(networkId, logoId, data, true);
            }
            throw e;
        }

        log.info("Service.saveLogoData(): saved. (networkId=%d logoId=%d)", networkId, logoId);
    }

    private _items: ServiceItem[] = [];
    private _unloadedServices: db.Service[] = [];
    private _saveTimerId: NodeJS.Timeout;
    private _channelIndex: Map<ChannelItem, ServiceItem[]> = null;

    get items(): ServiceItem[] {
        return this._items;
    }

    add(item: ServiceItem): void {
        if (this.get(item.id) !== null) {
            return;
        }

        this._items.push(item);
        this.invalidateChannelIndex();

        Event.emit("service", "create", item.export());

        this.save();
    }

    get(id: number): ServiceItem;
    get(networkId: number, serviceId: number): ServiceItem;
    get(id: number, serviceId?: number) {
        if (serviceId === undefined) {
            const l = this._items.length;
            for (let i = 0; i < l; i++) {
                if (this._items[i].id === id) {
                    return this._items[i];
                }
            }
        } else {
            const l = this._items.length;
            for (let i = 0; i < l; i++) {
                if (this._items[i].networkId === id && this._items[i].serviceId === serviceId) {
                    return this._items[i];
                }
            }
        }

        return null;
    }

    exists(id: number): boolean;
    exists(networkId: number, serviceId: number): boolean;
    exists(id: number, serviceId?: number) {
        return this.get(id, serviceId) !== null;
    }

    invalidateChannelIndex(): void {
        this._channelIndex = null;
    }

    findByChannel(channel: ChannelItem): ServiceItem[] {
        if (!this._channelIndex) {
            const index = new Map<ChannelItem, ServiceItem[]>();
            for (const item of this._items) {
                for (const route of item.channels) {
                    let items = index.get(route);
                    if (!items) {
                        items = [];
                        index.set(route, items);
                    }
                    items.push(item);
                }
            }
            this._channelIndex = index;
        }
        // Callers may sort or modify the result, as before.
        return this._channelIndex.get(channel)?.slice() || [];
    }

    findByNetworkId(networkId: number): ServiceItem[] {
        const items = [];

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].networkId === networkId) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    findByNetworkIdWithLogoId(networkId: number, logoId: number): ServiceItem[] {
        const items = [];

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].networkId === networkId && this._items[i].logoId === logoId) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    save(): void {
        clearTimeout(this._saveTimerId);
        this._saveTimerId = setTimeout(() => this._save(), 1000 * 10);
    }

    async load(): Promise<void> {
        log.debug("loading services...");

        let updated = false;
        let upgrade = false;

        const services = await db.loadServices(_.configIntegrity.channels, true);
        const unloaded = new Map<string, db.Service>();
        const currentConfigs = new Map<string, typeof _.config.channels>();
        for (const config of _.config.channels) {
            const key = `${config.type}/${config.channel}`;
            const rows = currentConfigs.get(key);
            if (rows) { rows.push(config); } else { currentConfigs.set(key, [config]); }
        }
        for (const service of services) {
            if (!service.channel || service.networkId === undefined || service.serviceId === undefined) {
                updated = true;
                continue;
            }
            const key = `${service.channel.type}/${service.channel.channel}`;
            const channelItem = _.channel.get(service.channel.type, service.channel.channel);
            if (channelItem === null && service.reception === undefined) {
                const configs = currentConfigs.get(key) || [];
                const first = configs[0];
                if (first && configs.some(config => !db.channelStateMatches({ ...service.channel, reception: db.channelStateReception(first) }, config))) {
                    // 未確定の旧サービスも、複数の受信入力から先頭行を選んで認定せずに保持する。
                    unloaded.set(`${service.networkId}/${service.serviceId}`, service);
                    updated = true;
                    continue;
                }
            }
            const input = { ...service.channel, reception: service.reception };
            if (channelItem === null || !db.channelStateMatches(input, channelItem.toJSON())) {
                const configured = currentConfigs.get(key)?.find(config => db.channelStateMatches(input, config));
                if (configured) {
                    // 無効・未接続の入力のサービスはAPIへ出さず、同じ入力の再有効化用にだけ保持する。
                    unloaded.set(`${service.networkId}/${service.serviceId}`, { ...service, reception: db.channelStateReception(configured) });
                    upgrade ||= service.reception === undefined;
                }
                // 予約が残っていても旧入力のサービスを新入力へ結び直さない。追加スキャンの完了まではサービスを利用できない。
                updated = true;
                continue;
            }

            upgrade ||= service.reception === undefined;
            // migrate logo data
            if (service.logoData) {
                const logoDataPath = Service.getLogoDataPath(service.networkId, service.logoId);
                log.warn("migrating deprecated property `logoData` to file `%s` in service#%d (%s) db", logoDataPath, service.id, service.name);
                Service.saveLogoData(service.networkId, service.logoId, Buffer.from(service.logoData, "base64"));

                // delete duplicates
                services.filter(s => s.networkId === service.networkId && s.logoId === service.logoId).forEach(s => {
                    delete s.logoData;
                });
                updated = true;
            }

            this.add(
                new ServiceItem(
                    channelItem,
                    service.networkId,
                    service.serviceId,
                    service.name,
                    service.type,
                    service.logoId,
                    service.remoteControlKeyId,
                    service.epgReady,
                    service.epgUpdatedAt,
                    service.streamId,
                    service.isFree
                )
            );
        }

        this._unloadedServices = [...unloaded.values()];
        if (upgrade) {
            // 旧形式を読み込めた回に受信設定を補完し、名前変更後も検証して復元できるようにする。
            clearTimeout(this._saveTimerId);
            await this._save();
        } else if (updated) {
            this.save();
        }

        setTimeout(() => this._initJobs(), 10000);
    }

    /** scans the services of a carrier after all the carriers of the group are discovered */
    queueDiscoveredTsmfScan(channel: ChannelItem): void {
        // the services of the TLV are added by the scan to update (`_scan()`)
        if (channel.getServices().length === 0) {
            this._queueScanToAdd(channel);
        } else {
            this._queueScanToUpdate(channel);
        }
    }

    private async _initJobs(): Promise<void> {
        log.debug("init service jobs...");

        // scan the channels of the services without `streamId` (migrated from the db of older versions),
        // only until a stream is received (the services not found by the scan, such as ended, are updated by the daily scan)
        if (_.channel.items.every(item => item.streams.length === 0)) {
            const migratingChannels = new Set(this._items.filter(item => item.streamId === undefined).map(item => item.channel));
            for (const channel of migratingChannels) {
                this._queueScanToUpdate(channel);
            }
        }

        // add services from channel config
        for (const channelConfig of _.config.channels) {
            if (channelConfig.isDisabled || !channelConfig.serviceId) {
                continue;
            }
            const channel = _.channel.get(channelConfig.type, channelConfig.channel);
            if (!channel || channel.route !== (channelConfig.route || getDefaultChannelRoute(channelConfig.type))) {
                continue;
            }
            const serviceId = channelConfig.serviceId;
            if (this.findByChannel(channel).some(service => service.serviceId === serviceId)) {
                continue;
            }

            this._queueCheckToAdd(channel, serviceId);
        }

        // SID指定だけの入力は選別を守る。同じ入力に全サービス行があれば、その行が要求するサービスも補完する。
        const specifiedChannels = new Set(_.config.channels.filter(config => !config.isDisabled && config.serviceId)
            .map(config => `${config.type}/${config.channel}/${config.route || getDefaultChannelRoute(config.type)}`));
        const mixedChannels = new Set(_.config.channels.filter(config => !config.isDisabled && !config.serviceId)
            .map(config => `${config.type}/${config.channel}/${config.route || getDefaultChannelRoute(config.type)}`)
            .filter(key => specifiedChannels.has(key)));
        for (const key of mixedChannels) { specifiedChannels.delete(key); }
        // scan services (no service channel only)
        _.job.add({
            key: "Service.Add.Scan.Find-Channels",
            name: "Service Add Scan [Find Targets]",
            fn: async () => {
                for (const channel of _.channel.items) {
                    const key = `${channel.type}/${channel.channel}/${channel.route}`;
                    const hasServices = this.findByChannel(channel).length > 0;
                    // 指定SIDの確認が先に成功しても、混在入力の全件探索を省略しない。
                    if (specifiedChannels.has(key) || (hasServices && !mixedChannels.has(key))) {
                        continue;
                    }

                    // サービスのある混在入力は補完を1回だけ試し、起動ごとの長期再試行を増やさない。
                    this._queueScanToAdd(channel, !hasServices);
                }
            },
            readyFn: async () => {
                // wait for all Service.Check-Add.* jobs to finish
                while (true) {
                    if (_.job.jobs.some(job => job.status !== "finished" && job.key.includes("Service.Add.Check."))) {
                        await sleep(1000);
                        continue;
                    }
                    return true;
                }
            }
        });

        // schedule service scan
        _.job.add({
            key: "Service.Updater.Add-Schedule",
            name: "Service Updater [Add Schedule]",
            fn: async () => {
                _.job.addSchedule({
                    key: "Service.Updater",
                    schedule: "5 6 * * *", // todo: config
                    job: {
                        key: "Service.Updater",
                        name: "Service Updater",
                        fn: async () => {
                            for (const channel of _.channel.items) {
                                if (this.findByChannel(channel).length === 0) {
                                    continue;
                                }

                                this._queueScanToUpdate(channel);
                            }
                        }
                    }
                });
            }
        });
    }

    private _save(): Promise<void> {
        log.debug("saving services...");

        const activeIds = new Set(this._items.map(item => item.id));
        return db.saveServices(
            [
                ...this._items.map(service => {
                    // `channels` is resolved from the channels db; reception is private persistence data.
                    const { channels, ...ret } = service.export(true);
                    return { ...ret, reception: db.channelStateReception(service.sourceChannel.toJSON()) };
                }),
                ...this._unloadedServices.filter(service => !activeIds.has(ServiceItem.getId(service.networkId, service.serviceId)))
            ],
            _.configIntegrity.channels
        );
    }

    private _queueCheckToAdd(channel: ChannelItem, serviceId: number): void {
        _.job.add({
            key: `Service.Add.Check.${channel.type}.${channel.channel}.${serviceId}`,
            name: `Service Add Check ${channel.type}/${channel.channel}/${serviceId}`,
            fn: () => this._checkToAdd(channel, serviceId),
            readyFn: async () => this._readyForScan(channel),
            retryOnFail: true,
            retryMax: (1000 * 60 * 60 * 12) / (1000 * 60 * 3), // (12時間 / retryDelay) = 12時間～
            retryDelay: 1000 * 60 * 3
        });
    }

    private async _readyForScan(channel: ChannelItem): Promise<boolean> {
        const stream = channel.streams.find(item => item.format === "tlv" && item.numberOfCarriers > 1);
        // waits for the tuners of all the carriers only if the TLV can be assembled (the same as the scan)
        const complete = stream && _.tuner.canReceiveTsmfCarriers(channel, stream.numberOfCarriers) && channel.hasAllCarriers(stream);
        if (complete) {
            return (await _.tuner.readyForJob([{ channel, relTs: stream.relTs }])) !== null;
        }
        // the relative streams detected by the remote Mirakurun are scanned by the remote tuners of each relative stream
        const remote = channel.streams.filter(item => item.remote === true).map(item => ({ channel, relTs: item.relTs }));
        return (await _.tuner.readyForJob(remote.length > 0 ? [{ channel }, ...remote] : channel)) !== null;
    }

    private _queueScanToAdd(channel: ChannelItem, retryOnFail = true): void {
        _.job.add({
            key: `Service.Add.Scan.${channel.type}.${channel.channel}`,
            name: `Service Add Scan ${channel.type}/${channel.channel}`,
            fn: async () => this._scan(channel, true),
            readyFn: async () => this._readyForScan(channel),
            retryOnFail,
            retryMax: (1000 * 60 * 60 * 12) / (1000 * 60 * 3), // (12時間 / retryDelay) = 12時間～
            retryDelay: 1000 * 60 * 3
        });
    }

    private _queueScanToUpdate(channel: ChannelItem): void {
        _.job.add({
            key: `Service.Update.Scan.${channel.type}.${channel.channel}`,
            name: `Service Update Scan ${channel.type}/${channel.channel}`,
            fn: async () => this._scan(channel, false),
            readyFn: async () => this._readyForScan(channel)
        });
    }

    private async _checkToAdd(channel: ChannelItem, serviceId: number): Promise<void> {
        log.info("ChannelItem#'%s' serviceId=%d check has started", channel.name, serviceId);

        let services: Awaited<ReturnType<typeof _.tuner.getServices>>;
        try {
            services = await _.tuner.getServices(channel);
        } catch (e) {
            log.warn("ChannelItem#'%s' serviceId=%d check has failed [%s]", channel.name, serviceId, e);
            throw new Error("Service check failed");
        }

        const service = services.find(service => service.serviceId === serviceId);
        if (!service) {
            log.warn("ChannelItem#'%s' serviceId=%d check has failed [no service]", channel.name, serviceId);

            // retry after 1 hour
            setTimeout(() => this._queueCheckToAdd(channel, serviceId), 3600000);
            return;
        }

        log.debug("ChannelItem#'%s' serviceId=%d: %s", channel.name, serviceId, JSON.stringify(service, null, "  "));

        const item = this.get(service.networkId, service.serviceId);
        if (item !== null) {
            // already added on another channel carrying the same stream
            item.streamId = service.streamId;
            item.isFree = service.isFree;
        } else {
            this.add(
                new ServiceItem(
                    channel, service.networkId, service.serviceId, service.name, service.type, service.logoId,
                    undefined, false, 0, service.streamId, service.isFree
                )
            );
        }

        log.info("ChannelItem#'%s' serviceId=%d check has finished", channel.name, serviceId);
    }

    private async _scan(channel: ChannelItem, add: boolean): Promise<void> {
        log.info("ChannelItem#'%s' service scan has started", channel.name);

        let services: Awaited<ReturnType<typeof _.tuner.getServices>>;
        try {
            services = await _.tuner.getServices(channel);
        } catch (e) {
            log.warn("ChannelItem#'%s' service scan has failed [%s]", channel.name, e);
            throw new Error("Service scan failed");
        }

        // the TLV of the carriers discovered is scanned after all the carriers are discovered (later than the TS sharing the carrier),
        // its services are added unless any service of the TLV has been added, even by the scan to update (not kept in memory to survive restarts)
        // (not for the channels of `serviceId`, only the services specified are added),
        // the same for the TLV detected by the remote Mirakurun (the remote Mirakurun scans the carriers by itself, later)
        const channelConfigs = _.config.channels.filter(config => !config.isDisabled && config.type === channel.type && config.channel === channel.channel &&
            (config.route || getDefaultChannelRoute(config.type)) === channel.route);
        const specifiedServiceIds = new Set(channelConfigs.filter(config => config.serviceId).map(config => config.serviceId!));
        // 全サービス行を含む同一入力では、SID指定行との和集合を登録する。
        const serviceIdSpecified = specifiedServiceIds.size > 0 && channelConfigs.every(config => config.serviceId);
        const newTlvStreams = serviceIdSpecified ? [] : channel.streams.filter(stream => stream.format === "tlv" && (stream.numberOfCarriers > 1 || stream.remote === true) &&
            this._items.some(item => item.networkId === stream.networkId && item.streamId === stream.streamId) === false);

        log.debug("ChannelItem#'%s' services: %s", channel.name, JSON.stringify(services, null, "  "));

        services.forEach(service => {
            const item = this.get(service.networkId, service.serviceId);
            if (item !== null) {
                item.streamId = service.streamId;
                item.isFree = service.isFree;
                item.name = service.name;
                item.type = service.type;
                if (service.logoId > -1) {
                    item.logoId = service.logoId;
                }
                item.remoteControlKeyId = service.remoteControlKeyId;
            } else if (add === true && (!serviceIdSpecified || specifiedServiceIds.has(service.serviceId)) || newTlvStreams.some(stream => stream.networkId === service.networkId && stream.streamId === service.streamId)) {
                this.add(
                    new ServiceItem(
                        channel,
                        service.networkId,
                        service.serviceId,
                        service.name,
                        service.type,
                        service.logoId,
                        service.remoteControlKeyId,
                        false,
                        0,
                        service.streamId,
                        service.isFree
                    )
                );
            }
        });

        log.info("ChannelItem#'%s' service scan has finished", channel.name);
    }
}

export default Service;
