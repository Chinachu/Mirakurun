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
import * as api from "../../../api";
import * as apid from "../../../../../api";
import _ from "../../../_";

export const parameters = [
    {
        in: "path",
        name: "index",
        type: "integer",
        minimum: 0,
        required: true
    }
];

export const get: Operation = (req, res) => {

    const tuner = _.tuner.get(req.params.index as any as number);

    if (tuner === null || Number.isInteger(tuner.pid) === false) {
        api.responseError(res, 404);
        return;
    }

    const tunerProcess: apid.TunerProcess = { pid: tuner.pid };
    api.responseJSON(res, tunerProcess);
};

get.apiDoc = {
    tags: ["tuners"],
    summary: "Get Tuner Process Info",
    operationId: "getTunerProcess",
    responses: {
        200: {
            description: "OK",
            schema: {
                $ref: "#/definitions/TunerProcess"
            }
        },
        404: {
            description: "Not Found",
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

export const del: Operation = async (req, res) => {

    const tuner = _.tuner.get(req.params.index as any as number);

    if (tuner === null || Number.isInteger(tuner.pid) === false) {
        api.responseError(res, 404);
        return;
    }

    try {
        await tuner.kill();
    } catch (err) {
        api.responseError(res, 500, err.message);
        return;
    }

    res.status(204).end();
};

del.apiDoc = {
    tags: ["tuners"],
    summary: "Kill Tuner Process",
    operationId: "killTunerProcess",
    responses: {
        204: {
            description: "Killed"
        },
        404: {
            description: "Not Found",
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
