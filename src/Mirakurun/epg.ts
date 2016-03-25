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
//import log = require('./log');
import ProgramItem = require('./ProgramItem');
const aribts = require('aribts');
const TsChar = aribts.TsChar;
const TsDate = aribts.TsDate;

//

class EPG extends stream.Writable {

    private _epg = {};

    constructor() {
        super({
            objectMode: true
        });

        //
    }

    _write(eit: any, encoding, callback) {

        const serviceId = eit.service_id;

        if (typeof this._epg[serviceId] === 'undefined') {
            this._epg[serviceId] = {
                schedule: {}
            };
        }

        const service = this._epg[serviceId];

        //console.log(eit);

        callback();
    }
}

const epg = new EPG();

export = epg;