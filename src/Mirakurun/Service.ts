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
import * as log from "./log";
import * as db from "./db";
import _ from "./_";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";

export default class Service {

    static get(id: number): ServiceItem;
    static get(networkId: number, serviceId: number): ServiceItem;
    static get(id: number, serviceId?: number) {
        return _.service.get(id, serviceId);
    }

    static exists(id: number): boolean;
    static exists(networkId: number, serviceId: number): boolean;
    static exists(id: number, serviceId?: number) {
        return _.service.exists(id, serviceId);
    }

    static findByChannel(channel: ChannelItem): ServiceItem[] {
        return _.service.findByChannel(channel);
    }

    static findByNetworkId(networkId: number): ServiceItem[] {
        return _.service.findByNetworkId(networkId);
    }

    static findByNetworkIdWithLogoId(networkId: number, logoId: number): ServiceItem[] {
        return _.service.findByNetworkIdWithLogoId(networkId, logoId);
    }

    static all(): ServiceItem[] {
        return _.service.items;
    }

    private _items: ServiceItem[] = [];
    private _saveTimerId: NodeJS.Timer;

    constructor() {

        this._load();
    }

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
        this._saveTimerId = setTimeout(() => this._save(), 500);
    }

    private _load(): void {

        log.debug("loading services...");

        let dropped = false;

        db.loadServices(_.configIntegrity.channels).forEach(service => {

            const channelItem = _.channel.get(service.channel.type, service.channel.channel);

            if (channelItem === null) {
                dropped = true;
                return;
            }

            if (service.networkId === undefined || service.serviceId === undefined) {
                dropped = true;
                return;
            }

            this.add(
                new ServiceItem(
                    channelItem,
                    service.networkId,
                    service.serviceId,
                    service.name,
                    service.type,
                    service.logoId,
                    service.logoData,
                    service.remoteControlKeyId,
                    service.epgReady,
                    service.epgUpdatedAt
                )
            );
        });

        if (dropped) {
            this.save();
        }
    }

    private _save(): void {

        log.debug("saving services...");

        db.saveServices(
            this._items.map(service => service.export(true)),
            _.configIntegrity.channels
        );
    }
}
