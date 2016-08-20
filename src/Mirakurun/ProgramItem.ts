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
import * as log from "./log";
import _ from "./_";
import db from "./db";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";

export default class ProgramItem {

    constructor(private _data: db.Program, firstAdd = false) {

        if (_.program.exists(_data.id) === true) {
            let item = _.program.get(_data.id);
            item.update(_data);
            return item;
        }

        const removedIds = [];

        if (firstAdd === false) {
            _.program.findByQuery({
                data: {
                    networkId: _data.networkId,
                    serviceId: _data.serviceId,
                    startAt: {
                        $gte: _data.startAt,
                        $lt: _data.startAt + _data.duration
                    }
                }
            }).forEach(item => {

                item.remove();

                log.debug(
                    "ProgramItem#%d (networkId=%d, eventId=%d) has removed for redefine to ProgramItem#%d (eventId=%d)",
                    item.data.id, item.data.networkId, item.data.eventId,
                    _data.id, _data.eventId
                );

                removedIds.push(item.data.id);
            });
        }

        _.program.add(this);
        this._updated();

        removedIds.forEach(id => Event.emit("program-redefine", { from: id, to: _data.id }));
    }

    get id(): number {
        return this._data.id;
    }

    get service(): ServiceItem {
        return _.service.get(this._data.networkId, this._data.serviceId);
    }

    get data(): db.Program {
        return this._data;
    }

    update(data: db.Program): void {

        if (common.updateObject(this._data, data) === true) {
            _.program.save();
            this._updated();
        }
    }

    getStream(user: common.User): Promise<stream.Readable> {
        return _.tuner.getProgramStream(this, user);
    }

    remove(): void {
        _.program.remove(this);
    }

    private _updated(): void {
        Event.emit("program", this._data)
    }
}