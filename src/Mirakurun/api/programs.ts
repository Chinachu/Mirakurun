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
import * as db from "../db";
import Program from "../Program";

export const get: Operation = (req, res) => {

    let programs: db.Program[];

    if (Object.keys(req.query).length !== 0) {
        programs = Program.findByQuery({
            data: req.query
        });
    } else {
        programs = Program.all();
    }

    api.responseJSON(res, programs);
};

get.apiDoc = {
    tags: ["programs"],
    operationId: "getPrograms",
    parameters: [
        {
            in: "query",
            name: "networkId",
            type: "integer",
            required: false
        },
        {
            in: "query",
            name: "serviceId",
            type: "integer",
            required: false
        },
        {
            in: "query",
            name: "eventId",
            type: "integer",
            required: false
        }
    ],
    responses: {
        200: {
            description: "OK",
            schema: {
                type: "array",
                items: {
                    $ref: "#/definitions/Program"
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
