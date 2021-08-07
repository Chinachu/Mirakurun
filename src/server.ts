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
require("dotenv").config();
import { execSync } from "child_process";
import { createHash } from "crypto";

if (process.platform === "linux") {
    if (process.getuid() === 0) {
        execSync(`renice -n -10 -p ${ process.pid }`);
        execSync(`ionice -c 1 -n 7 -p ${ process.pid }`);
    } else {
        console.warn("running in not root!");
    }
}

process.title = "Mirakurun: Server";

process.on("uncaughtException", err => {
    ++status.errorCount.uncaughtException;
    console.error(err.stack);
});
process.on("unhandledRejection", err => {
    ++status.errorCount.unhandledRejection;
    console.error(err);
});

setEnv("SERVER_CONFIG_PATH", "/usr/local/etc/mirakurun/server.yml");
setEnv("TUNERS_CONFIG_PATH", "/usr/local/etc/mirakurun/tuners.yml");
setEnv("CHANNELS_CONFIG_PATH", "/usr/local/etc/mirakurun/channels.yml");
setEnv("SERVICES_DB_PATH", "/usr/local/var/db/mirakurun/services.json");
setEnv("PROGRAMS_DB_PATH", "/usr/local/var/db/mirakurun/programs.json");
setEnv("LOGO_DATA_DIR_PATH", "/usr/local/var/db/mirakurun/logo-data");

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

_.config.server = config.loadServer();
_.config.channels = config.loadChannels();
_.configIntegrity.channels = createHash("sha256").update(JSON.stringify(_.config.channels)).digest("base64");
_.config.tuners = config.loadTuners();

if (typeof _.config.server.logLevel === "number") {
    (<any> log).logLevel = _.config.server.logLevel;
}
if (typeof _.config.server.maxLogHistory === "number") {
    (<any> log).maxLogHistory = _.config.server.maxLogHistory;
}

_.event = new Event();
_.tuner = new Tuner();
_.channel = new Channel();
_.service = new Service();
_.program = new Program();
_.server = new Server();

if (process.env.SETUP === "true") {
    log.info("setup is done.");
    process.exit(0);
}

_.server.init();

function setEnv(name: string, value: string) {
    process.env[name] = process.env[name] || value;
}
