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
import * as stream from "stream";
import * as fs from "fs";
import sift from "sift";
import * as log from "./log";
import * as db from "./db";
import _ from "./_";
import Event from "./Event";
import queue from "./queue";
import ServiceItem from "./ServiceItem";
import ProgramItem from "./ProgramItem";

export default class Program {

    static get(id: number): ProgramItem {
        return _.program.get(id);
    }

    static exists(id: number): boolean {
        return _.program.exists(id);
    }

    static findByQuery(query: object): ProgramItem[] {
        return _.program.findByQuery(query);
    }

    static findByServiceId(serviceId: number): ProgramItem[] {
        return _.program.findByServiceId(serviceId);
    }

    static all(): ProgramItem[] {
        return _.program.items;
    }

    private _items: ProgramItem[] = [];
    private _saveTimerId: NodeJS.Timer;
    private _programGCInterval: number = _.config.server.programGCInterval || 1000 * 60 * 15;

    constructor() {

        this._load();

        setTimeout(this._gc.bind(this), this._programGCInterval);
    }

    get items(): ProgramItem[] {
        return this._items;
    }

    add(item: ProgramItem, firstAdd: boolean = false): void {

        if (this.get(item.id) !== null) {
            return;
        }

        const removedIds = [];

        if (firstAdd === false) {
            _.program.findConflicts(
                item.data.networkId,
                item.data.serviceId,
                item.data.startAt,
                item.data.startAt + item.data.duration
            ).forEach(conflictedItem => {

                this.remove(conflictedItem);

                log.debug(
                    "ProgramItem#%d (networkId=%d, eventId=%d) has removed for redefine to ProgramItem#%d (eventId=%d)",
                    conflictedItem.data.id, conflictedItem.data.networkId, conflictedItem.data.eventId,
                    item.data.id, item.data.eventId
                );

                removedIds.push(conflictedItem.data.id);
            });
        }

        this._items.push(item);

        if (firstAdd === false) {
            Event.emit("program", "create", item.data);
            removedIds.forEach(id => Event.emit("program", "redefine", { from: id, to: item.data.id }));
        }

        this.save();
    }

    get(id: number): ProgramItem {

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].id === id) {
                return this._items[i];
            }
        }

        return null;
    }

    remove(item: ProgramItem): void {

        const index = this._items.indexOf(item);

        if (index !== -1) {
            this._items.splice(index, 1);

            this.save();
        }
    }

    exists(id: number): boolean {
        return this.get(id) !== null;
    }

    findByQuery(query: object): ProgramItem[] {
        return sift(query, this._items);
    }

    findByServiceId(serviceId: number): ProgramItem[] {

        const items = [];

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].data.serviceId === serviceId) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    findConflicts(networkId: number, serviceId: number, start: number, end: number): ProgramItem[] {

        const items = [];

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            const item = this._items[i];
            if (
                item.data.networkId === networkId &&
                item.data.serviceId === serviceId &&
                item.data.startAt >= start &&
                item.data.startAt < end
            ) {
                items.push(item);
            }
        }

        return items;
    }

    async findByNetworkIdAndReplace(networkId: number, programs: db.Program[]): Promise<void> {

        let count = 0;

        for (let i = this._items.length - 1; i >= 0; i--) {
            if (this._items[i].data.networkId === networkId) {
                this._items.splice(i, 1);
                --count;
            }
        }

        for (const program of programs) {
            this.add(new ProgramItem(program), true);
            ++count;
        }

        log.debug("programs replaced (networkId=%d, count=%d)", networkId, count);

        this.save();
    }

    save(): void {
        clearTimeout(this._saveTimerId);
        this._saveTimerId = setTimeout(() => this._save(), 3000);
    }

    private _load(): void {

        log.debug("loading programs...");

        const now = Date.now();
        let dropped = false;

        db.loadPrograms(_.configIntegrity.channels).forEach(program => {

            if (typeof program.networkId === "undefined") {
                dropped = true;
                return;
            }
            if (now > (program.startAt + program.duration)) {
                dropped = true;
                return;
            }

            this.add(new ProgramItem(program), true);
        });

        if (dropped) {
            this.save();
        }
    }

    private _save(): void {

        log.debug("saving programs...");

        db.savePrograms(
            this._items.map(program => program.data),
            _.configIntegrity.channels
        );
    }

    private _gc(): void {

        log.debug("Program GC has queued");

        queue.add(async () => {

            const now = Date.now();
            let count = 0;

            this._items.forEach(program => {
                if (now > (program.data.startAt + program.data.duration)) {
                    ++count;
                    this.remove(program);
                }
            });

            setTimeout(this._gc.bind(this), this._programGCInterval);

            log.info("Program GC has finished and removed %d programs", count);
        });
    }
}
