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

    static all(): ProgramItem[] {
        return _.program.items;
    }

    private _itemMap: Map<number, ProgramItem> = new Map<number, ProgramItem>();
    private _saveTimerId: NodeJS.Timer;
    private _programGCInterval: number = _.config.server.programGCInterval || 1000 * 60 * 15;

    constructor() {

        this._load();

        setTimeout(this._gc.bind(this), this._programGCInterval);
    }

    /** CAUTION: This getter method creates a new Array object every time. */
    get items(): ProgramItem[] {
        return Array.from(this._itemIterator);
    }

    private get _itemIterator(): IterableIterator<ProgramItem> {
        return this._itemMap.values();
    }

    add(item: ProgramItem, firstAdd: boolean = false): void {

        if (this.exists(item.id)) {
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

        this._itemMap.set(item.id, item);

        if (firstAdd === false) {
            Event.emit("program", "create", item.data);
            removedIds.forEach(id => Event.emit("program", "redefine", { from: id, to: item.data.id }));
        }

        this.save();
    }

    get(id: number): ProgramItem | null {
        return this._itemMap.get(id) || null;
    }

    remove(item: ProgramItem): void {
        if (this._itemMap.delete(item.id)) {
            this.save();
        }
    }

    exists(id: number): boolean {
        return this._itemMap.has(id);
    }

    findByQuery(query: object): ProgramItem[] {
        // Pass `this.items` instead of `this._itemIterator`.
        // Because IterableIterator<T> doesn't have the `filter()` method.
        return sift(query, this.items);
    }

    findByNetworkId(networkId: number): ProgramItem[] {

        const items = [];

        for (const item of this._itemIterator) {
            if (item.data.networkId === networkId) {
                items.push(item);
            }
        }

        return items;
    }

    findByNetworkIdAndTime(networkId: number, time: number): ProgramItem[] {

        const items = [];

        for (const item of this._itemIterator) {
            if (item.data.networkId === networkId && item.data.startAt <= time && item.data.startAt + item.data.duration > time) {
                items.push(item);
            }
        }

        return items;
    }

    findConflicts(networkId: number, serviceId: number, start: number, end: number): ProgramItem[] {

        const items = [];

        for (const item of this._itemIterator) {
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

    findByNetworkIdAndReplace(networkId: number, programs: db.Program[]): void {

        let count = 0;

        // The `reverse()` method never changes the original data.  Because
        // `this.items` returns a new Array object created from the original
        // data.
        for (const item of this.items.reverse()) {
            if (item.data.networkId === networkId) {
                // Calling `this.remove(item)` here is safe.  Because that never
                // changes the Array object we're iterating here.
                this.remove(item);
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
        this._saveTimerId = setTimeout(() => this._save(), 1000 * 10);
    }

    private _load(): void {

        log.debug("loading programs...");

        const now = Date.now();
        let dropped = false;

        db.loadPrograms(_.configIntegrity.channels).forEach(program => {

            if (program.networkId === undefined) {
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
            this._collectDBData(),
            _.configIntegrity.channels
        );
    }

    private _collectDBData(): db.Program[] {
        const results = [];
        for (const item of this._itemIterator) {
            results.push(item.data);
        }
        return results;
    }

    private _gc(): void {

        log.debug("Program GC has queued");

        queue.add(async () => {

            const now = Date.now();
            let count = 0;

            for (const program of this._itemIterator) {
                if (now > (program.data.startAt + program.data.duration)) {
                    ++count;
                    this.remove(program);
                }
            }

            setTimeout(this._gc.bind(this), this._programGCInterval);

            log.info("Program GC has finished and removed %d programs", count);
        });
    }
}
