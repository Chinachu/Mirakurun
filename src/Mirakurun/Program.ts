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
import sift from "sift";
import * as common from "./common";
import * as log from "./log";
import * as db from "./db";
import _ from "./_";
import Event from "./Event";
import queue from "./queue";

export function getProgramItemId(networkId: number, serviceId: number, eventId: number): number {
    return parseInt(`${networkId}${serviceId.toString(10).padStart(5, "0")}${eventId.toString(10).padStart(5, "0")}`, 10);
}

export default class Program {

    static get(id: number): db.Program {
        return _.program.get(id);
    }

    static exists(id: number): boolean {
        return _.program.exists(id);
    }

    static findByQuery(query: object): db.Program[] {
        return _.program.findByQuery(query);
    }

    static all(): db.Program[] {
        return _.program.items;
    }

    private _itemMap: Map<number, db.Program> = new Map<number, db.Program>();
    private _saveTimerId: NodeJS.Timer;
    private _programGCInterval: number = _.config.server.programGCInterval || 1000 * 60 * 15;

    constructor() {
        this._load();

        setTimeout(this._gc.bind(this), this._programGCInterval);
    }

    /** CAUTION: This getter method creates a new Array object every time. */
    get items(): db.Program[] {
        return Array.from(this._itemMap.values());
    }

    add(item: db.Program, firstAdd: boolean = false): void {

        if (this.exists(item.id)) {
            return;
        }

        const removedIds = [];

        if (firstAdd === false) {
            for (const conflictedItem of this.findConflicts(
                item.networkId,
                item.serviceId,
                item.startAt,
                item.startAt + item.duration,
                item._pf
            )) {
                this.remove(conflictedItem.id);
                removedIds.push(conflictedItem.id);

                log.debug(
                    "ProgramItem#%d (networkId=%d, eventId=%d) has removed for redefine to ProgramItem#%d (eventId=%d)",
                    conflictedItem.id, conflictedItem.networkId, conflictedItem.eventId, item.id, item.eventId
                );
            }
        }

        this._itemMap.set(item.id, item);

        if (firstAdd === false) {
            Event.emit("program", "create", item);
            for (const id of removedIds) {
                Event.emit("program", "redefine", { from: id, to: item.id });
            }
        }

        this.save();
    }

    get(id: number): db.Program | null {
        return this._itemMap.get(id) || null;
    }

    set(id: number, props: Partial<db.Program>): void {
        const item = this.get(id);
        if (item && common.updateObject(item, props) === true) {
            this.save();
            Event.emit("program", "update", item);
        }
    }

    remove(id: number): void {
        if (this._itemMap.delete(id)) {
            this.save();
        }
    }

    exists(id: number): boolean {
        return this._itemMap.has(id);
    }

    findByQuery(query: object): db.Program[] {
        // Pass `this.items` instead of `this._itemIterator`.
        // Because IterableIterator<T> doesn't have the `filter()` method.
        return sift(query, this.items);
    }

    findByNetworkId(networkId: number): db.Program[] {

        const items = [];

        for (const item of this._itemMap.values()) {
            if (item.networkId === networkId) {
                items.push(item);
            }
        }

        return items;
    }

    findByNetworkIdAndTime(networkId: number, time: number): db.Program[] {

        const items = [];

        for (const item of this._itemMap.values()) {
            if (item.networkId === networkId && item.startAt <= time && item.startAt + item.duration > time) {
                items.push(item);
            }
        }

        return items;
    }

    findConflicts(networkId: number, serviceId: number, start: number, end: number, _pf?: true): db.Program[] {

        const items = [];

        for (const item of this._itemMap.values()) {
            if (
                item.networkId === networkId &&
                item.serviceId === serviceId &&
                (
                    (item.startAt >= start && item.startAt < end) ||
                    (item.startAt <= start && item.startAt + item.duration > start)
                ) &&
                (!item._pf || _pf)
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
            if (item.networkId === networkId) {
                // Calling `this.remove(item)` here is safe.  Because that never
                // changes the Array object we're iterating here.
                this.remove(item.id);
                --count;
            }
        }

        for (const program of programs) {
            this.add(program, true);
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

        db.loadPrograms(_.configIntegrity.channels).forEach(item => {

            if (item.networkId === undefined) {
                dropped = true;
                return;
            }
            if (now > (item.startAt + item.duration)) {
                dropped = true;
                return;
            }

            this.add(item, true);
        });

        if (dropped) {
            this.save();
        }
    }

    private _save(): void {

        log.debug("saving programs...");

        db.savePrograms(
            this.items,
            _.configIntegrity.channels
        );
    }

    private _gc(): void {

        log.debug("Program GC has queued");

        queue.add(async () => {

            const shortExp = Date.now() - 1000 * 60 * 60 * 1; // 1 hour
            const longExp = Date.now() - 1000 * 60 * 60 * 24; // 24 hours
            const maximum = Date.now() + 1000 * 60 * 60 * 24 * 9; // 9 days
            let count = 0;

            for (const item of this._itemMap.values()) {
                if (
                    (item.duration === 1 ? longExp : shortExp) > (item.startAt + item.duration) ||
                    maximum < item.startAt
                ) {
                    ++count;
                    this.remove(item.id);
                }
            }

            setTimeout(this._gc.bind(this), this._programGCInterval);

            log.info("Program GC has finished and removed %d programs", count);
        });
    }
}
