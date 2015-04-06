/// <reference path="../typings/tsd.d.ts" />
'use strict';

import fs = require('fs');
import uuid = require('node-uuid');

import mirakurun = require('./index');

var config: mirakurun.IServerConfig = {
    id: uuid.v4(),

    path: '',

    tuners: [],
    tunerGroups: []
};

if (process.env.MIRAKURUN_CONFIG_PATH) {
    config.path = '/var/run/mirakurun.sock';
    config.logLevel = 2;

    if (fs.existsSync(process.env.MIRAKURUN_CONFIG_PATH) === true) {
        config = require(process.env.MIRAKURUN_CONFIG_PATH);
    }
} else {
    console.error('Note: running in debug mode for console.');

    config.port = 40772;
    config.logLevel = 3;
}

mirakurun.createServer(config);