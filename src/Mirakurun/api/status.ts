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
import { Operation } from "express-openapi";
import * as api from "../api";
import * as apid from "../../../api";
import status from "../status";
import _ from "../_";

const pkg = require("../../../package.json");

export const get: Operation = (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200);

    api.responseJSON(res, getStatus() as apid.Status);
};

get.apiDoc = {
    tags: ["status"],
    summary: "Get Status",
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

export function getStatus(): apid.Status {
    const ret: apid.Status = {
        time: Date.now(),
        version: pkg.version,
        process: {
            arch: process.arch,
            platform: process.platform,
            versions: process.versions,
            env: {
                PATH: process.env.PATH,
                DOCKER: process.env.DOCKER,
                DOCKER_NETWORK: process.env.DOCKER_NETWORK,
                pm_uptime: process.env.pm_uptime,
                NODE_ENV: process.env.NODE_ENV,
                SERVER_CONFIG_PATH: process.env.SERVER_CONFIG_PATH,
                TUNERS_CONFIG_PATH: process.env.TUNERS_CONFIG_PATH,
                CHANNELS_CONFIG_PATH: process.env.CHANNELS_CONFIG_PATH,
                SERVICES_DB_PATH: process.env.SERVICES_DB_PATH,
                PROGRAMS_DB_PATH: process.env.PROGRAMS_DB_PATH,
                LOGO_DATA_DIR_PATH: process.env.LOGO_DATA_DIR_PATH
            },
            pid: process.pid,
            memoryUsage: process.memoryUsage()
        },
        epg: {
            gatheringNetworks: [],
            storedEvents: _.program.itemMap.size
        },
        rpcCount: status.rpcCount,
        streamCount: {
            tunerDevice: _.tuner.devices.filter(td => td.isUsing === true).length,
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

    for (const nid in status.epg) {
        if (status.epg[nid] === true) {
            ret.epg.gatheringNetworks.push(parseInt(nid, 10));
        }
    }

    return ret;
}
