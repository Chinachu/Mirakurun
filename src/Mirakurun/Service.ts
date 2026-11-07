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
import { sleep } from "./common";
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

        const services = await db.loadServices(_.configIntegrity.channels, true);
        for (const service of services) {
            const channelItem = _.channel.get(service.channel.type, service.channel.channel);

            if (channelItem === null) {
                updated = true;
                continue;
            }

            if (service.networkId === undefined || service.serviceId === undefined) {
                updated = true;
                continue;
            }

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
                    service.streamId
                )
            );
        }

        if (updated) {
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
            if (!channel) {
                continue;
            }
            const serviceId = channelConfig.serviceId;
            if (this.findByChannel(channel).some(service => service.serviceId === serviceId)) {
                continue;
            }

            this._queueCheckToAdd(channel, serviceId);
        }

        // scan services (no service channel only)
        _.job.add({
            key: "Service.Add.Scan.Find-Channels",
            name: "Service Add Scan [Find Targets]",
            fn: async () => {
                for (const channel of _.channel.items) {
                    if (this.findByChannel(channel).length > 0) {
                        continue;
                    }

                    this._queueScanToAdd(channel);
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

    private _save(): void {
        log.debug("saving services...");

        db.saveServices(
            this._items.map(service => {
                // `channels` is resolved from the channels db
                const { channels, ...ret } = service.export();
                return ret;
            }),
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
        const complete = stream && _.tuner.canReceiveTsmfCarriers(channel, stream.numberOfCarriers) &&
            channel.getBondedChannels()?.length === stream.numberOfCarriers;
        return (await _.tuner.readyForJob(complete ? [{ channel, relTs: stream.relTs }] : channel)) !== null;
    }

    private _queueScanToAdd(channel: ChannelItem): void {
        _.job.add({
            key: `Service.Add.Scan.${channel.type}.${channel.channel}`,
            name: `Service Add Scan ${channel.type}/${channel.channel}`,
            fn: async () => this._scan(channel, true),
            readyFn: async () => this._readyForScan(channel),
            retryOnFail: true,
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
        } else {
            this.add(
                new ServiceItem(
                    channel, service.networkId, service.serviceId, service.name, service.type, service.logoId,
                    undefined, false, 0, service.streamId
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
        // (not for the channels of `serviceId`, only the services specified are added)
        const serviceIdSpecified = _.config.channels.some(config => config.type === channel.type && config.channel === channel.channel && config.serviceId);
        const newTlvStreams = serviceIdSpecified ? [] : channel.streams.filter(stream => stream.format === "tlv" && stream.numberOfCarriers > 1 &&
            this._items.some(item => item.networkId === stream.networkId && item.streamId === stream.streamId) === false);

        log.debug("ChannelItem#'%s' services: %s", channel.name, JSON.stringify(services, null, "  "));

        services.forEach(service => {
            const item = this.get(service.networkId, service.serviceId);
            if (item !== null) {
                item.streamId = service.streamId;
                item.name = service.name;
                item.type = service.type;
                if (service.logoId > -1) {
                    item.logoId = service.logoId;
                }
                item.remoteControlKeyId = service.remoteControlKeyId;
            } else if (add === true || newTlvStreams.some(stream => stream.networkId === service.networkId && stream.streamId === service.streamId)) {
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
                        service.streamId
                    )
                );
            }
        });

        log.info("ChannelItem#'%s' service scan has finished", channel.name);
    }
}

export default Service;
