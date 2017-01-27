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
"use strict";

import { Operation } from "express-openapi";
import * as api from "../api";
import { Status } from "../../../api";
import status from "../status";
import Program from "../Program";
import Tuner from "../Tuner";

const pkg = require("../../../package.json");

export const get: Operation = (req, res) => {

    const ret: Status = {
        version: pkg.version,
        process: {
            arch: process.arch,
            platform: process.platform,
            versions: process.versions,
            pid: process.pid,
            memoryUsage: process.memoryUsage()
        },
        epg: {
            gatheringNetworks: [],
            storedEvents: Program.all().length
        },
        streamCount: {
            tunerDevice: Tuner.all().filter(td => td.isUsing === true).length,
            tsFilter: status.streamCount.tsFilter,
            decoder: status.streamCount.decoder
        },
        errorCount: status.errorCount,
        timerAccuracy: {
            // ns → μs
            last: status.timerAccuracy.last / 1000,
            m1: {
                avg: (status.timerAccuracy.m1.reduce((a, b) => a + b) / status.timerAccuracy.m1.length) / 1000,
                min: Math.min.apply(null, status.timerAccuracy.m1) / 1000,
                max: Math.max.apply(null, status.timerAccuracy.m1) / 1000
            },
            m5: {
                avg: (status.timerAccuracy.m5.reduce((a, b) => a + b) / status.timerAccuracy.m5.length) / 1000,
                min: Math.min.apply(null, status.timerAccuracy.m5) / 1000,
                max: Math.max.apply(null, status.timerAccuracy.m5) / 1000
            },
            m15: {
                avg: (status.timerAccuracy.m15.reduce((a, b) => a + b) / status.timerAccuracy.m15.length) / 1000,
                min: Math.min.apply(null, status.timerAccuracy.m15) / 1000,
                max: Math.max.apply(null, status.timerAccuracy.m15) / 1000
            }
        }
    };

    for (let nid in status.epg) {
        if (status.epg[nid] === true) {
            ret.epg.gatheringNetworks.push(parseInt(nid, 10));
        }
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200);
    res.end(JSON.stringify(ret, null, 2));
};

get.apiDoc = {
    tags: ["status"],
    operationId: "getStatus",
    responses: {
        200: {
            description: "OK",
            schema: {
                $ref: "#/definitions/Status"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};