/// <reference path="../../typings/node/node.d.ts" />
'use strict';

import common = require('../common');
import os = require('os');

module util {

    export function getPrivateIPv4Addresses(): string[] {

        var addresses = [];

        var interfaces = os.networkInterfaces();
        Object.keys(interfaces).forEach(k => {
            addresses = addresses.concat(
                interfaces[k]
                    .filter(a => {
                        return a.family === 'IPv4' &&
                            a.internal === false &&
                            common.regexp.privateIPv4Address.test(a.address) === true
                    })
                    .map(a => a.address)
            );
        });

        return addresses;
    }
}

export = util;