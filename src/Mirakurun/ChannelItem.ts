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
import common = require('./common');
import config = require('./config');
import Channel = require('./Channel');
import Service = require('./Service');
import ServiceItem = require('./ServiceItem');
import Tuner = require('./Tuner');

class ChannelItem {

    private _name: string;
    private _type: string;
    private _channel: string;
    private _satelite: string;

    constructor(config: config.Channel) {

        const pre = Channel.get(config.type, config.channel);
        if (pre !== null) {
            if (config.serviceId) {
                pre.addService(config.serviceId, config.name);
            }

            Channel.add(pre);
            return;
        }

        this._name = config.name;
        this._type = config.type;
        this._channel = config.channel;
        this._satelite = config.satelite;

        if (config.serviceId) {
            this.addService(config.serviceId);
        }

        Channel.add(this);
    }

    get name(): string {
        return this._name;
    }

    get type(): string {
        return this._type;
    }

    get channel(): string {
        return this._channel;
    }

    get satelite(): string {
        return this._satelite;
    }

    addService(id: number, name: string = this._name): this {
        new ServiceItem(this, id, name);
        return this;
    }

    getServices(): ServiceItem[] {
        return Service.findByChannel(this);
    }

    getStream(user: common.User): Promise<stream.Readable> {
        return Tuner.getChannelStream(this, user);
    }
}

export = ChannelItem;