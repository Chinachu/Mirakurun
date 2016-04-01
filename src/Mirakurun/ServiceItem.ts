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
import common = require('./common');
import db = require('./db');
import Event = require('./Event');
import ChannelItem = require('./ChannelItem');

class ServiceItem {

    constructor(private _channel: ChannelItem, private _id: number, private _name?: string) {

        if (_.service.exists(_id) === true) {
            return this;
        }

        _.service.add(this);
        this._updated();
    }

    get id(): number {
        return this._id;
    }

    get name(): string {
        return this._name || '';
    }

    get channel(): ChannelItem {
        return this._channel;
    }

    set name(name: string) {

        if (this._name !== name) {
            this._name = name;

            _.service.save();
            this._updated();
        }
    }

    export(): db.Service {
        return {
            id: this._id,
            name: this._name || '',
            channel: {
                type: this._channel.type,
                channel: this._channel.channel
            }
        };
    }

    getStream(user: common.User): Promise<stream.Readable> {
        return _.tuner.getServiceStream(this, user);
    }

    private _updated(): void {
        Event.emit('service', this.export())
    }
}

export = ServiceItem;