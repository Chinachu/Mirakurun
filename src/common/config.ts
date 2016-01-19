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
/// <reference path="../../typings/js-yaml/js-yaml.d.ts" />
'use strict';

import log = require('../log');
import fs = require('fs');
import yaml = require('js-yaml');

module config {

    export enum ChannelType {
        'GR' = 0,
        'BS' = 1,
        'CS' = 2,
        'SKY' = 10
    }

    export interface Server {
        // as Local Server
        path?: string;

        // as Remote Server
        port?: number;
        host?: string;

        logLevel?: log.LogLevel;
    }

    export interface Tuner {
        devices: TunerDevice[];
        group: { [key: string]: TunerGroup }
    }

    export interface TunerDevice {
        name: string;
        group?: string;

        types: ChannelType[];

        // for chardev
        command?: string;

        // for dvb
        dvbTuneCommand?: string;
        dvbDevicePath?: string;

        // decoder
        decoder?: string;

        isDisabled?: boolean;
    }

    export interface TunerGroup {
        controlWait?: number;
    }

    export interface Channel {
        name: string;

        type: ChannelType;

        // passed to tuning command
        channel: string;
        satelite?: string;

        // service id
        serviceId?: number;
    }

    export function getServer(): Server {

        return yaml.safeLoad(fs.readFileSync('/usr/local/etc/mirakurun/server.yml', 'utf8'));
    }
    export function getTuner(): Tuner {

        return yaml.safeLoad(fs.readFileSync('/usr/local/etc/mirakurun/tuner.yml', 'utf8'));
    }
    export function getChannels(): Channel[] {

        return yaml.safeLoad(fs.readFileSync('/usr/local/etc/mirakurun/channels.yml', 'utf8'));
    }
}

export = config;