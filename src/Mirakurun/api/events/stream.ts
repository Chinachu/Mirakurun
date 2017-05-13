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
import { Operation } from "express-openapi";
import * as api from "../../api";
import Event, { EventMessage } from "../../Event";

export const get: Operation = (req, res) => {

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200);
    res.write("[\n");

    req.setTimeout(1000 * 60 * 60, () => { return; });
    req.once("close", () => Event.removeListener(_listener));

    Event.on(_listener);

    function _listener(message: EventMessage) {

        if (req.query.resource && req.query.resource !== message.resource) {
            return;
        }
        if (req.query.type && req.query.type !== message.type) {
            return;
        }

        res.write(JSON.stringify(message) + "\n,\n");
    }
};

get.apiDoc = {
    tags: ["events", "stream"],
    operationId: "getEventsStream",
    parameters: [
        {
            in: "query",
            name: "resource",
            type: "string",
            enum: ["program", "service", "tuner"],
            required: false
        },
        {
            in: "query",
            name: "type",
            type: "string",
            enum: ["create", "update", "redefine"],
            required: false
        }
    ],
    responses: {
        200: {
            description: "OK",
            schema: {
                type: "array",
                items: {
                    $ref: "#/definitions/Event"
                }
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
