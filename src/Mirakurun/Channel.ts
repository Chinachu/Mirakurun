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

import stream = require('stream');
import _ = require('./_');
import log = require('./log');
import config = require('./config');
import ChannelItem = require('./ChannelItem');
import Tuner = require('./Tuner');

class Channel {

    private _items: ChannelItem[] = [];

    constructor() {

        _.channel = this;

        this.load();
    }

    get items(): ChannelItem[] {
        return this._items;
    }

    add(item: ChannelItem): void {

        if (this.get(item.type, item.channel) === null) {
            this._items.push(item);
        }
    }

    get(type: string, channel: string): ChannelItem {

        let i, l = this._items.length;
        for (i = 0; i < l; i++) {
            if (this._items[i].channel === channel && this._items[i].type === type) {
                return this._items[i];
            }
        }

        return null;
    }

    findByType(type: string): ChannelItem[] {

        const items = [];

        let i, l = this._items.length;
        for (i = 0; i < l; i++) {
            if (this._items[i].type === type) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    private load(): void {

        log.debug('loading channels...');

        const channels = config.loadChannels();

        channels.forEach((channel, i) => {

            if (typeof channel.name !== 'string') {
                log.error('invalid type of property `name` in channel#%d configuration', i);
                return;
            }

            if (channel.type !== 'GR' && channel.type !== 'BS' && channel.type !== 'CS' && channel.type !== 'SKY') {
                log.error('invalid type of property `type` in channel#%d (%s) configuration', i, channel.name);
                return;
            }

            if (typeof channel.channel !== 'string') {
                log.error('invalid type of property `channel` in channel#%d (%s) configuration', i, channel.name);
                return;
            }

            if (channel.satelite && typeof channel.satelite !== 'string') {
                log.error('invalid type of property `satelite` in channel#%d (%s) configuration', i, channel.name);
                return;
            }

            if (channel.serviceId && typeof channel.serviceId !== 'number') {
                log.error('invalid type of property `serviceId` in channel#%d (%s) configuration', i, channel.name);
                return;
            }

            if(channel.isDisabled === true) {
                return;
            }

            if (Tuner.typeExists(channel.type) === false) {
                return;
            }

            new ChannelItem(channel);
        });
    }

    static add(item: ChannelItem): void {
        return _.channel.add(item);
    }

    static get(type: string, channel: string): ChannelItem {
        return _.channel.get(type, channel);
    }

    static findByType(type: string): ChannelItem[] {
        return _.channel.findByType(type);
    }

    static all(): ChannelItem[] {
        return _.channel.items;
    }
}

export = Channel;