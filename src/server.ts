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
/// <reference path="../typings/node/node.d.ts" />
'use strict';

if (process.platform !== 'win32') {
    if (process.getuid() !== 0) {
        console.error('root please.');
        process.exit(1);
    }
}

import util = require('util');
import Server = require('./Mirakurun/Server');

process.title = 'Mirakurun: Server';

process.on('uncaughtException', err => {
    console.error(err.stack);
});

setEnv('SERVER_CONFIG_PATH', '/usr/local/etc/mirakurun/server.yml');
setEnv('TUNERS_CONFIG_PATH', '/usr/local/etc/mirakurun/tuners.yml');
setEnv('CHANNELS_CONFIG_PATH', '/usr/local/etc/mirakurun/channels.yml');
setEnv('SERVICES_DB_PATH', '/usr/local/var/db/mirakurun/services.json');
setEnv('PROGRAMS_DB_PATH', '/usr/local/var/db/mirakurun/programs.json');
setEnv('LOG_STDOUT', '/usr/local/var/log/mirakurun.stdout.log');
setEnv('LOG_STDERR', '/usr/local/var/log/mirakurun.stderr.log');

new Server();

function setEnv(name: string, value: string) {
    process.env[name] = process.env[name] || value;
}