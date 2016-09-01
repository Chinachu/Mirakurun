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
import { Status } from "../../../api.d.ts";
import status from "../status";

export const get: Operation = (req, res) => {

    const ret: Status = {
        epg: {
            gatheringNetworks: []
        },
        errorCount: status.errorCount,
        timerAccuracy: {
            last: status.timerAccuracy.last,
            m1: {
                avg: status.timerAccuracy.m1.reduce((a, b) => a + b) / status.timerAccuracy.m1.length,
                min: Math.min.apply(null, status.timerAccuracy.m1),
                max: Math.max.apply(null, status.timerAccuracy.m1)
            },
            m5: {
                avg: status.timerAccuracy.m5.reduce((a, b) => a + b) / status.timerAccuracy.m5.length,
                min: Math.min.apply(null, status.timerAccuracy.m5),
                max: Math.max.apply(null, status.timerAccuracy.m5)
            },
            m15: {
                avg: status.timerAccuracy.m15.reduce((a, b) => a + b) / status.timerAccuracy.m15.length,
                min: Math.min.apply(null, status.timerAccuracy.m15),
                max: Math.max.apply(null, status.timerAccuracy.m15)
            }
        }
    };

    for (let nid in status.epg) {
        if (status.epg[nid] === true) {
            ret.epg.gatheringNetworks.push(parseInt(nid, 10));
        }
    }

    api.responseJSON(res, ret);
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