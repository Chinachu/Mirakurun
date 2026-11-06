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
import _ from "../../../_";

export const parameters = [
    {
        in: "path",
        name: "id",
        type: "integer",
        minimum: 10000000000,
        maximum: 655356553565535,
        required: true
    },
    {
        in: "header",
        name: "X-Mirakurun-Priority",
        type: "integer",
        minimum: 0
    },
    {
        in: "query",
        name: "decode",
        type: "integer",
        minimum: 0,
        maximum: 1
    },
    api.streamFormatParameter
];

export const get: Operation = (req, res) => {
    const program = _.program.get(req.params.id as any as number);

    if (program === null) {
        api.responseError(res, 404);
        return;
    }

    const service = _.service.get(program.networkId, program.serviceId);
    if (service === null) {
        api.responseError(res, 404);
        return;
    }

    api.responseStream(req, res, service.channels, userReq => _.tuner.initProgramStream(program, userReq, res))
        .then(tsFilter => {
            if (tsFilter) {
                req.setTimeout(1000 * 60 * 10); // 10 minites
            }
        });
};

get.apiDoc = {
    tags: ["programs", "stream"],
    operationId: "getProgramStream",
    produces: ["video/MP2T", "application/octet-stream"],
    responses: {
        200: {
            description: "OK",
            headers: {
                "X-Mirakurun-Tuner-User-ID": {
                    type: "string"
                }
            }
        },
        404: {
            description: "Not Found"
        },
        406: {
            description: "Requested Stream Format Unavailable"
        },
        503: {
            description: "Tuner Resource Unavailable"
        },
        default: {
            description: "Unexpected Error"
        }
    }
};

// HEAD request support
export const head: Operation = (...args) => get(...args);

head.apiDoc = {
    ...get.apiDoc,
    operationId: undefined
};
