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

import os = require('os');
import regexp = require('./regexp');

module system {

    export function getPrivateIPv4Addresses(): string[] {

        const addresses = [];

        const interfaces = os.networkInterfaces();
        Object.keys(interfaces).forEach(k => {
            interfaces[k]
                .filter(a => {
                    return (
                        a.family === 'IPv4' &&
                        a.internal === false &&
                        regexp.privateIPv4Address.test(a.address) === true
                    );
                })
                .forEach(a => addresses.push(a.address))
        });

        return addresses;
    }
}

export = system;