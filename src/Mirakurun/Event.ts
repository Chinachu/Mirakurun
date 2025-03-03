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
import _ from "./_";

export interface EventMessage<T = any> {
    readonly resource: EventResource;
    readonly type: EventType;
    readonly data: T;
    readonly time: number;
}

export type EventResource = "program" | "service" | "tuner";
export type EventType = "create" | "update" | "remove";

export default class Event extends EventEmitter {

    static get log(): EventMessage[] {
        return _.event.log;
    }

    static onEvent(listener: (message: EventMessage) => void): void {
        _.event.on("event", listener);
    }

    static onceEvent(listener: (message: EventMessage) => void): void {
        _.event.once("event", listener);
    }

    static removeListener(listener: (...args: any[]) => void): void {
        _.event.removeListener("event", listener);
    }

    static emit(resource: EventResource, type: EventType, data: any): boolean {

        const message: EventMessage = {
            resource: resource,
            type: type,
            data: deepClone(data),
            time: Date.now()
        };

        return _.event.emit("event", message);
    }

    private _log: EventMessage[] = [];

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

    get log(): EventMessage[] {
        return this._log;
    }
}
