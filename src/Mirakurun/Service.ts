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

    get items(): ServiceItem[] {
        return this._items;
    }

    add(item: ServiceItem): void {
        if (this.get(item.id) !== null) {
            return;
        }

        this._items.push(item);

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

    findByChannel(channel: ChannelItem): ServiceItem[] {
        const items = [];

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].channel === channel) {
                items.push(this._items[i]);
            }
        }

        return items;
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

        const services = await db.loadServices(_.configIntegrity.channels);
        for (const service of services) {
            const channelItem = _.channel.get(service.channel.type, service.channel.channel);

            if (channelItem === null) {
                updated = true;
                return;
            }

            if (service.networkId === undefined || service.serviceId === undefined) {
                updated = true;
                return;
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
                    service.epgUpdatedAt
                )
            );
        }

        if (updated) {
            this.save();
        }

        await sleep(5000);

        // add services from channel config
        for (const channelConfig of _.config.channels) {
            if (!channelConfig.serviceId) {
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

            this._queueCheckAndAdd(channel, serviceId);
        }

        // scan services (no service channel only)
        _.job.add({
            key: "Service.Scan-Add.Find-Channels",
            name: "Service Scan (Add) [Find Targets]",
            fn: async () => {
                for (const channel of _.channel.items) {
                    if (this.findByChannel(channel).length > 0) {
                        continue;
                    }

                    this._queueScanAndAdd(channel);
                }
            },
            readyFn: async () => {
                // wait for all Service.Check-Add.* jobs to finish
                while (true) {
                    const jobItems = [..._.job.runningJobItems,
                        ..._.job.queuedJobItems,
                        ..._.job.standbyJobItems
                    ];
                    if (jobItems.some(jobItem => jobItem.key.includes("Service.Check-Add."))) {
                        await sleep(1000);
                        continue;
                    }
                    return true;
                }
            }
        });

        // schedule service scan
        _.job.add({
            key: "Service.Scan-Update.Add-Schedule",
            name: "Service Scan (Update) [Add Schedule]",
            fn: async () => {
                for (const channel of _.channel.items) {
                    _.job.addSchedule({
                        key: `Service.Scan-Update.${channel.type}.${channel.channel}`,
                        schedule: "5 6 * * *", // todo: config
                        job: {
                            key: `Service.Scan-Update.${channel.type}.${channel.channel}`,
                            name: `Service Scan (Update) ${channel.type}/${channel.channel}`,
                            fn: async () => this._scan(channel, false),
                            readyFn: () => _.tuner.readyForJob(channel)
                        }
                    });
                }
            }
        });
    }

    private _save(): void {
        log.debug("saving services...");

        db.saveServices(
            this._items.map(service => service.export()),
            _.configIntegrity.channels
        );
    }

    private _queueCheckAndAdd(channel: ChannelItem, serviceId: number): void {
        _.job.add({
            key: `Service.Check-Add.${channel.type}.${channel.channel}.${serviceId}`,
            name: `Service Check (Add) ${channel.type}/${channel.channel}/${serviceId}`,
            fn: () => this._checkAndAdd(channel, serviceId),
            readyFn: () => _.tuner.readyForJob(channel),
            retryOnFail: true,
            retryMax: (1000 * 60 * 60 * 12) / (1000 * 60 * 3), // (12時間 / retryDelay) = 12時間～
            retryDelay: 1000 * 60 * 3
        });
    }

    private _queueScanAndAdd(channel: ChannelItem): void {
        _.job.add({
            key: `Service.Scan-Add.${channel.type}.${channel.channel}`,
            name: `Service Scan (Add) ${channel.type}/${channel.channel}`,
            fn: async () => this._scan(channel, true),
            readyFn: () => _.tuner.readyForJob(channel),
            retryOnFail: true,
            retryMax: (1000 * 60 * 60 * 12) / (1000 * 60 * 3), // (12時間 / retryDelay) = 12時間～
            retryDelay: 1000 * 60 * 3
        });
    }

    private async _checkAndAdd(channel: ChannelItem, serviceId: number): Promise<void> {
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
            setTimeout(() => this._queueCheckAndAdd(channel, serviceId), 3600000);
            return;
        }

        log.debug("ChannelItem#'%s' serviceId=%d: %s", channel.name, serviceId, JSON.stringify(service, null, "  "));

        this.add(
            new ServiceItem(channel, service.networkId, service.serviceId, service.name, service.type, service.logoId)
        );

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

        log.debug("ChannelItem#'%s' services: %s", channel.name, JSON.stringify(services, null, "  "));

        services.forEach(service => {
            const item = this.get(service.networkId, service.serviceId);
            if (item !== null) {
                item.name = service.name;
                item.type = service.type;
                if (service.logoId > -1) {
                    item.logoId = service.logoId;
                }
                item.remoteControlKeyId = service.remoteControlKeyId;
            } else if (add === true) {
                this.add(
                    new ServiceItem(
                        channel,
                        service.networkId,
                        service.serviceId,
                        service.name,
                        service.type,
                        service.logoId,
                        service.remoteControlKeyId
                    )
                );
            }
        });

        log.info("ChannelItem#'%s' service scan has finished", channel.name);
    }
}

export default Service;
