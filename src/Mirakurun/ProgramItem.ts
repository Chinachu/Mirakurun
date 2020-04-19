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
import * as stream from "stream";
import * as common from "./common";
import * as log from "./log";
import * as db from "./db";
import _ from "./_";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";

export default class ProgramItem {

    static getId(networkId: number, serviceId: number, eventId: number): number {
        return parseInt(networkId + (serviceId / 100000).toFixed(5).slice(2) + (eventId / 100000).toFixed(5).slice(2), 10);
    }

    constructor(public data: db.Program) {

        if (!data.id) {
            data.id = ProgramItem.getId(data.networkId, data.serviceId, data.eventId);
        }
    }

    get id(): number {
        return this.data.id;
    }

    get service(): ServiceItem {
        return _.service.get(this.data.networkId, this.data.serviceId);
    }

    update(data: db.Program): void {

        if (common.updateObject(this.data, data) === true) {
            _.program.save();
            Event.emit("program", "update", this.data);
        }
    }

    getStream(user: common.User): Promise<stream.Readable> {
        return _.tuner.getProgramStream(this, user);
    }
}
