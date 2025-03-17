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
import EventEmitter from "eventemitter3";
import { deepClone } from "./common";
import * as apid from "../../api";
import _ from "./_";

export class Event extends EventEmitter {
    static get log(): apid.Event[] {
        return _.event.log;
    }

    static onEvent(listener: (message: apid.Event) => void): void {
        _.event.on("event", listener);
    }

    static onceEvent(listener: (message: apid.Event) => void): void {
        _.event.once("event", listener);
    }

    static removeListener(listener: (...args: any[]) => void): void {
        _.event.removeListener("event", listener);
    }

    static emit(resource: apid.EventResource, type: apid.EventType, data: any): boolean {
        const message: apid.Event = {
            resource: resource,
            type: type,
            data: deepClone(data),
            time: Date.now()
        };

        return _.event.emit("event", message);
    }

    private _log: apid.Event[] = [];

    constructor() {
        super();

        this.on("event", message => {
            this._log.push(message);

            // testing
            if (this._log.length > 100) {
                this._log.shift();
            }
        });
    }

    get log(): apid.Event[] {
        return this._log;
    }
}

export default Event;
