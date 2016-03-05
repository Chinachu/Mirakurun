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

import events = require('events');
import log = require('./log');
import hammer = require('./hammer');
import config = require('./config');
import TunerDevice = require('./TunerDevice');

class Tuner extends events.EventEmitter {

    private _devices: TunerDevice[] = [];

    constructor() {
        super();

        this.loadTuners();
    }

    loadTuners() {

        log.debug('loading tuners...');

        const tuners = config.getTuners();

        tuners
            .filter((tuner, i) => {
                // validate config

                if (!tuner.name || !tuner.types || !tuner.command) {
                    log.error('missing required property in tuner#%s configuration', i);
                    return false;
                }

                if (typeof tuner.name !== 'string') {
                    log.error('invalid type of property `name` in tuner#%s configuration', i);
                    return false;
                }

                if (Array.isArray(tuner.types) === false) {
                    console.log(tuner);
                    log.error('invalid type of property `types` in tuner#%s configuration', i);
                    return false;
                }

                if (typeof tuner.command !== 'string') {
                    log.error('invalid type of property `command` in tuner#%s configuration', i);
                    return false;
                }

                if (tuner.dvbDevicePath && typeof tuner.dvbDevicePath !== 'string') {
                    log.error('invalid type of property `dvbDevicePath` in tuner#%s configuration', i);
                    return false;
                }

                if (tuner.isDisabled) {
                    return false;
                }

                return true;
            })
            .forEach((tuner, i) => {
                // get tuner device instance
                this._devices.push(
                    new TunerDevice(i, tuner)
                );
            });

        log.info('%s of %s tuners loaded', this._devices.length, tuners.length);
    }

    //getStream
}

export = Tuner;