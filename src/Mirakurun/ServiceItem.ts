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
/// <reference path="../../typings/index.d.ts" />
"use strict";

import * as stream from "stream";
import * as common from "./common";
import _ from "./_";
import db from "./db";
import Event from "./Event";
import ChannelItem from "./ChannelItem";

export default class ServiceItem {

    private _id: number;

    constructor(
        private _channel: ChannelItem,
        private _networkId: number,
        private _serviceId: number,
        private _name?: string,
        private _type?: number,
        private _logoId?: number,
        private _logoData?: string
    ) {

        this._id = ServiceItem.createId(_networkId, _serviceId);

        if (_.service.exists(this._id) === true) {
            return this;
        }

        _.service.add(this);
        Event.emit("service", "create", this.export());
    }

    get id(): number {
        return this._id;
    }

    get networkId(): number {
        return this._networkId;
    }

    get serviceId(): number {
        return this._serviceId;
    }

    get name(): string {
        return this._name || "";
    }

    get type(): number {
        return this._type;
    }

    get logoId(): number {
        return this._logoId;
    }

    get logoData(): NodeBuffer {
        return new Buffer(this._logoData, 'base64');
    }

    get hasLogoData(): boolean {
        return !!this._logoData;
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

    set type(type: number) {

        if (this._type !== type) {
            this._type = type;

            _.service.save();
            this._updated();
        }
    }

    set logoId(logoId: number) {

        if (this._logoId !== logoId) {
            this._logoId = logoId;

            _.service.save();
            this._updated();
        }
    }

    set logoData(logo: NodeBuffer) {

        if (this._logoData !== logo.toString('base64')) {
            this._logoData = logo.toString('base64');

            _.service.save();
            this._updated();
        }
    }

    export(full = false): db.Service {

        const ret: db.Service = {
            id: this._id,
            serviceId: this._serviceId,
            networkId: this._networkId,
            name: this._name || "",
            type: this._type,
            logoId: this._logoId,
            channel: {
                type: this._channel.type,
                channel: this._channel.channel
            }
        };

        if (full === true) {
            ret.logoData = this._logoData;
        }

        return ret;
    }

    getStream(user: common.User): Promise<stream.Readable> {
        return _.tuner.getServiceStream(this, user);
    }

    private _updated(): void {
        Event.emit("service", "update", this.export());
    }

    static createId(networkId: number, serviceId: number): number {
        return parseInt(networkId + (serviceId / 100000).toFixed(5).slice(2), 10);
    }
}