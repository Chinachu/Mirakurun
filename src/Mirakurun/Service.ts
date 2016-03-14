/*
   Copyright 2016 Yuki KAN

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
/// <reference path="../../typings/node/node.d.ts" />
'use strict';

import events = require('events');
import stream = require('stream');
import _ = require('./_');
import log = require('./log');
import db = require('./db');
import Channel = require('./Channel');
import ChannelItem = require('./ChannelItem');
import ServiceItem = require('./ServiceItem');

class Service extends events.EventEmitter {

    private _items: ServiceItem[];
    private _saveTimerId: NodeJS.Timer;

    constructor() {
        super();

        this._load();

        _.service = this;
    }

    add(item: ServiceItem): void {

        if (this.get(item.id) === null) {
            this._items.push(item);

            this.save();
        }
    }

    get(id: number): ServiceItem {

        let i, l = this._items.length;
        for (i = 0; i < l; i++) {
            if (this._items[i].id === id) {
                return this._items[i];
            }
        }

        return null;
    }

    exists(id: number): boolean {
        return this.get(id) !== null;
    }

    findByChannel(channel: ChannelItem): ServiceItem[] {

        const items = [];

        let i, l = this._items.length;
        for (i = 0; i < l; i++) {
            if (this._items[i].channel === channel) {
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

        log.debug('loading services...');

        let dropped = false;

        db.loadServices().forEach(service => {

            const channelItem = Channel.get(service.channel.type, service.channel.channel);

            if (channelItem === null) {
                dropped = true;
                return;
            }

            new ServiceItem(channelItem, service.id, service.name);
        });

        if (dropped) {
            this.save();
        }
    }

    private _save(): void {

        log.debug('saving services...');

        db.saveServices(
            this._items.map(service => service.export())
        );
    }

    static add(item: ServiceItem): void {
        return _.service.add(item);
    }

    static get(id: number): ServiceItem {
        return _.service.get(id);
    }

    static exists(id: number): boolean {
        return _.service.exists(id);
    }

    static findByChannel(channel: ChannelItem): ServiceItem[] {
        return _.service.findByChannel(channel);
    }

    static save(): void {
        return _.service.save();
    }
}

export = Service;