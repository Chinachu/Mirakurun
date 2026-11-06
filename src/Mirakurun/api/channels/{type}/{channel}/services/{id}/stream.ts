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
import * as api from "../../../../../../api";
import * as apid from "../../../../../../../../api";
import { channelTypes } from "../../../../../../common";
import _ from "../../../../../../_";

export const parameters = [
    {
        in: "path",
        name: "type",
        type: "string",
        enum: channelTypes,
        required: true
    },
    {
        in: "path",
        name: "channel",
        type: "string",
        required: true
    },
    {
        in: "path",
        name: "id",
        type: "integer",
        maximum: 6553565535,
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
    const channel = _.channel.get(req.params.type as apid.ChannelType, req.params.channel);

    if (channel === null) {
        api.responseError(res, 404);
        return;
    }

    const reqId = req.params.id as any as number;
    const service = _.service.findByChannel(channel).find(sv => (sv.id === reqId || sv.serviceId === reqId));

    if (!service) {
        api.responseError(res, 404);
        return;
    }

    api.responseStream(req, res, { isTlv: service.isTlv, channels: service.channels }, userReq => service.getStream(userReq, res));
};

get.apiDoc = {
    tags: ["channels", "services", "stream"],
    operationId: "getServiceStreamByChannel",
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
