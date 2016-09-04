#!/usr/bin/env node
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
/// <reference path="../../typings/index.d.ts" />
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const execSync = require("child_process").execSync;
const yaml = require("js-yaml");
const munin = require("munin-plugin");
const pkg = require("../../package.json");

let configPath = "/usr/local/etc/mirakurun/server.yml";

if (process.platform === "win32") {
    configPath = path.join(process.env.USERPROFILE, ".Mirakurun\\server.yml");
}

if (process.platform === "linux") {
    execSync(`renice -n 19 -p ${ process.pid }`);
    execSync(`ionice -c 3 -p ${ process.pid }`);
}

const config = yaml.safeLoad(fs.readFileSync(configPath, "utf8"));

if (!config.path) {
    console.error("Error: Socket Path Undefined.");
    process.exit(1);
}

{
    const opt = {
        method: "GET",
        socketPath: config.path,
        path: "/api/status",
        userAgent: `Mirakurun/${pkg.version} (munin-plugin) Node/${process.version} (${process.platform})`
    };

    const req = http.request(opt, res => {

        if (res.statusCode !== 200 || res.headers["content-type"] !== "application/json; charset=utf-8") {
            console.error("Error: Invalid Response.");
            process.exit(1);
        }

        let body = "";

        res.on("data", chunk => {
            body += chunk;
        });

        res.once("end", () => {
            finalize(JSON.parse(body));
        });
    });

    req.end();
}

function finalize(status) {

    munin.create([
        () => {
            const g = new munin.Graph('Mirakurun Memory Usage','Bytes','mirakurun');
            g.setScale(true);
            g.args = {
                "--base": "1024",
                "-l": "0"
            };
            g.add(new munin.Model.Default('rss').setDraw("AREA").setValue(status.process.memoryUsage.rss));
            g.add(new munin.Model.Default('heapTotal').setDraw("AREA").setValue(status.process.memoryUsage.heapTotal));
            g.add(new munin.Model.Default('heapUsed').setDraw("AREA").setValue(status.process.memoryUsage.heapUsed));
            return g;
        },
        () => {
            const g = new munin.Graph('Mirakurun Programs DB','Events','mirakurun');
            g.setScale(true);
            g.add(new munin.Model.Default('stored events').setDraw("AREA").setValue(status.epg.storedEvents));
            return g;
        },
        () => {
            const g = new munin.Graph('Mirakurun Stream','Count','mirakurun');
            g.add(new munin.Model.Default("decoder").setDraw("AREA").setValue(status.streamCount.decoder));
            g.add(new munin.Model.Default("TSFilter").setDraw("STACK").setValue(status.streamCount.tsFilter));
            g.add(new munin.Model.Default("TunerDevice").setDraw("STACK").setValue(status.streamCount.tunerDevice));
            return g;
        },
        () => {
            const g = new munin.Graph('Mirakurun Error','Count','mirakurun');

            const uncaughtException = new munin.Model.Default('uncaught exception')
            uncaughtException.setDraw("AREA");
            uncaughtException.setType("DERIVE");
            uncaughtException.setMin("0");
            uncaughtException.setValue(status.errorCount.uncaughtException);

            const bufferOverflow = new munin.Model.Default('buffer overflow')
            bufferOverflow.setDraw("STACK");
            bufferOverflow.setType("DERIVE");
            bufferOverflow.setMin("0");
            bufferOverflow.setValue(status.errorCount.bufferOverflow);

            const tunerDeviceRespawn = new munin.Model.Default('tuner device respawn')
            tunerDeviceRespawn.setDraw("STACK");
            tunerDeviceRespawn.setType("DERIVE");
            tunerDeviceRespawn.setMin("0");
            tunerDeviceRespawn.setValue(status.errorCount.tunerDeviceRespawn);

            g.add(uncaughtException);
            g.add(bufferOverflow);
            g.add(tunerDeviceRespawn);

            return g;
        },
        () => {
            const g = new munin.Graph('Mirakurun Timer Accuracy','Microseconds','mirakurun');
            g.add(new munin.Model.Default('avg m1').setDraw("AREA").setValue(status.timerAccuracy.m1.avg));
            g.add(new munin.Model.Default('avg m5').setDraw("LINE1").setValue(status.timerAccuracy.m5.avg));
            g.add(new munin.Model.Default('avg m15').setDraw("LINE1").setValue(status.timerAccuracy.m15.avg));
            return g;
        }
    ].map(f => f()));
}