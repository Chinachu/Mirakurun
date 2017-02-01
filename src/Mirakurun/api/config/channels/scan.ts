/*
   Copyright 2017 Yuki KAN

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
import * as api from "../../../api";
import * as config from "../../../config";
import db from "../../../db";
import Tuner from "../../../Tuner";

let isScanning = false;

const channelOrder = {
    GR: 1,
    BS: 2,
    CS: 3,
    SKY: 4
};

export const put: Operation = async (req, res) => {

    if (isScanning === true) {
        api.responseError(res, 409, "Already Scanning");
        return;
    }

    isScanning = true;
    const type = req.query.type;
    const result: config.Channel[] = config.loadChannels().filter(channel => channel.type !== type);
    let count = 0;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);
    res.write(`channel scanning... (type: "${type}")\n\n`);

    for (let i = req.query.min; i <= req.query.max; i++) {
        const channel = i.toString(10);
        res.write(`channel: "${channel}" ...\n`);

        let services: db.Service[];
        try {
            services = await Tuner.getServices(<any>{
                type: type,
                channel: channel
            });
        } catch (e) {
            res.write(`-> no signal. [${e}] \n\n`);
            continue;
        }

        services = services.filter(service => service.type === 1);
        res.write(`-> ${services.length} services found.\n`);

        if (services.length === 0) {
            res.write(`\n`);
            continue;
        }

        let name = services[0].name;

        for (const service of services) {
            for (let i = 1; i < name.length && i < service.name.length; i++) {
                if (name[i] !== service.name[i]) {
                    name = name.slice(0, i);
                    break;
                }
            }
        }

        name = name.trim();

        if (name.length === 0) {
            name = services[0].name || `${type}${channel}`;
        }

        const channelItem: config.Channel = {
            name: name,
            type: type,
            channel: channel
        };
        result.unshift(channelItem);
        ++count;

        res.write(`-> ${JSON.stringify(channelItem)}\n\n`);
    }

    result.sort((a, b) => channelOrder[a.type] - channelOrder[b.type]);
    config.saveChannels(result);

    res.write(`-> total ${count} channels found and ${result.length} channels stored.\n\n`);

    isScanning = false;

    res.write(`channel scan has completed and saved successfully.\n`);
    res.write(`**RESTART REQUIRED** to apply changes.\n`);

    res.end();
};

put.apiDoc = {
    tags: ["config"],
    operationId: "channelScan",
    produces: [
        "text/plain",
        "application/json"
    ],
    parameters: [
        {
            in: "query",
            name: "type",
            type: "string",
            enum: ["GR"],
            default: "GR"
        },
        {
            in: "query",
            name: "min",
            type: "integer",
            default: 13
        },
        {
            in: "query",
            name: "max",
            type: "integer",
            default: 52
        }
    ],
    responses: {
        200: {
            description: "OK"
        },
        409: {
            description: "Already Scanning",
            schema: {
                $ref: "#/definitions/Error"
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