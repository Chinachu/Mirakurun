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
import fs = require('fs');
import _ = require('./_');
import log = require('./log');
import db = require('./db');
import ServiceItem = require('./ServiceItem');
import ProgramItem = require('./ProgramItem');

class Program {

    private _items: ProgramItem[] = [];
    private _saveTimerId: NodeJS.Timer;

    constructor() {

        _.program = this;

        this._load();

        setInterval(this._gc.bind(this), 1000 * 60 * 15);
    }

    get items(): ProgramItem[] {
        return this._items;
    }

    add(item: ProgramItem): void {

        if (this.get(item.id) === null) {
            this._items.push(item);

            this.save();
        }
    }

    get(id: number): ProgramItem {

        let i, l = this._items.length;
        for (i = 0; i < l; i++) {
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

    findByServiceId(serviceId: number): ProgramItem[] {

        const items = [];

        let i, l = this._items.length;
        for (i = 0; i < l; i++) {
            if (this._items[i].data.serviceId === serviceId) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    findByServiceItemId(id: number): ProgramItem[] {

        const items = [];

        let i, l = this._items.length;
        for (i = 0; i < l; i++) {
            if (this._items[i].id === id) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    save(): void {
        clearTimeout(this._saveTimerId);
        this._saveTimerId = setTimeout(() => this._save(), 3000);
    }

    private _load(): void {

        log.debug('loading programs...');

        const now = Date.now();
        let dropped = false;

        db.loadPrograms().forEach(program => {

            if (typeof program.networkId === 'undefined') {
                dropped = true;
                return;
            }
            if (now > (program.startAt + program.duration)) {
                dropped = true;
                return;
            }

            new ProgramItem(program);
        });

        if (dropped === true) {
            this.save();
        }
    }

    private _save(): void {

        log.debug('saving programs...');

        db.savePrograms(
            this._items.map(program => program.data)
        );
    }

    private _gc(): void {

        const now = Date.now();

        this._items.forEach(program => {
            if (now > (program.data.startAt + program.data.duration)) {
                program.remove();
            }
        });
    }

    static add(item: ProgramItem): void {
        return _.program.add(item);
    }

    static get(id: number): ProgramItem {
        return _.program.get(id);
    }

    static remove(item: ProgramItem): void {
        return _.program.remove(item);
    }

    static exists(id: number): boolean {
        return _.program.exists(id);
    }

    static findByServiceId(serviceId: number): ProgramItem[] {
        return _.program.findByServiceId(serviceId);
    }

    static findByServiceItemId(id: number): ProgramItem[] {
        return _.program.findByServiceItemId(id);
    }

    static all(): ProgramItem[] {
        return _.program.items;
    }

    static save(): void {
        return _.program.save();
    }
}

export = Program;