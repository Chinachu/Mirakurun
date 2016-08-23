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
import * as api from "../../../api";
import Tuner from "../../../Tuner";

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

    let tuner = Tuner.get(req.params.index);

    if (tuner === null || Number.isInteger(tuner.pid) === false) {
        api.responseError(res, 404);
        return;
    }

    api.responseJSON(res, { pid: tuner.pid });
};

get.apiDoc = {
    tags: ["tuners"],
    operationId: "getTunerProcess",
    responses: {
        200: {
            description: "OK",
            schema: {
                type: "object",
                properties: {
                    pid: {
                        type: "integer"
                    }
                }
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

export const del: Operation = (req, res) => {

    const tuner = Tuner.get(req.params.index);

    if (tuner === null || Number.isInteger(tuner.pid) === false) {
        api.responseError(res, 404);
        return;
    }

    tuner.kill()
        .then(() => api.responseJSON(res, {pid: null}))
        .catch((error: Error) => api.responseError(res, 500, error.message));
};

del.apiDoc = {
    tags: ["tuners"],
    operationId: "killTunerProcess",
    responses: {
        200: {
            description: "OK",
            schema: {
                type: "object",
                properties: {
                    pid: {
                        type: "null"
                    }
                }
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