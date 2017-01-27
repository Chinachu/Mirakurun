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
/// <reference path="../typings/index.d.ts" />
"use strict";

if (process.platform !== "win32") {
    if (process.getuid() !== 0) {
        console.error("root please.");
        process.exit(1);
    }
}

import { execSync } from "child_process";
import _ from "./Mirakurun/_";
import status from "./Mirakurun/status";
import Event from "./Mirakurun/Event";
import Tuner from "./Mirakurun/Tuner";
import Channel from "./Mirakurun/Channel";
import Service from "./Mirakurun/Service";
import Program from "./Mirakurun/Program";
import Server from "./Mirakurun/Server";
import * as config from "./Mirakurun/config";
import * as log from "./Mirakurun/log";

process.title = "Mirakurun: Server";

process.on("uncaughtException", err => {
    ++status.errorCount.uncaughtException;
    console.error(err.stack);
});

setEnv("SERVER_CONFIG_PATH", "/usr/local/etc/mirakurun/server.yml");
setEnv("TUNERS_CONFIG_PATH", "/usr/local/etc/mirakurun/tuners.yml");
setEnv("CHANNELS_CONFIG_PATH", "/usr/local/etc/mirakurun/channels.yml");
setEnv("SERVICES_DB_PATH", "/usr/local/var/db/mirakurun/services.json");
setEnv("PROGRAMS_DB_PATH", "/usr/local/var/db/mirakurun/programs.json");

if (process.platform === "linux") {
    execSync(`renice -n -10 -p ${ process.pid }`);
    execSync(`ionice -c 1 -n 7 -p ${ process.pid }`);
}

_.config.server = config.loadServer();
_.config.channels = config.loadChannels();
_.config.tuners = config.loadTuners();

if (typeof _.config.server.logLevel === "number") {
    (<any>log).logLevel = _.config.server.logLevel;
}

new Event();
new Tuner();
new Channel();
new Service();
new Program();
new Server();

function setEnv(name: string, value: string) {
    process.env[name] = process.env[name] || value;
}