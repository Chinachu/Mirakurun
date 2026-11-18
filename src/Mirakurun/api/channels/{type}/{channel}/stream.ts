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
import {Operation} from "express-openapi";
import * as api from "../../../../api";
import * as apid from "../../../../../../api";
import { channelTypes } from "../../../../common";
import _ from "../../../../_";

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
    api.streamFormatParameter,
    {
        in: "query", name: "rawTsmf", type: "boolean",
        description: "Transfers the outer TS packets including NULL and transport-error packets without extraction, bonding or decoding. Normal streams with TS input remove NULL and transport-error packets and apply decoding as configured/requested. Use only with input devices that output the outer TS. An unscanned TSMF carrier is allowed; the logical channel format alone does not identify the physical input. Only format=ts (or omitted), decode=0 (or omitted) and no tsmfRelTs are allowed."
    },
    {
        in: "query",
        name: "tsmfRelTs",
        type: "integer",
        minimum: 1,
        maximum: 15,
        description: "The relative stream of TSMF (default: the channel setting). Use rawTsmf=true to transfer the outer multiplex including NULL packets."
    }
];

export const get: Operation = (req, res) => {
    const channel = _.channel.get(req.params.type as apid.ChannelType, req.params.channel);

    if (channel === null) {
        api.responseError(res, 404);
        return;
    }

    // express-openapi coerces query booleans; validate the original wire values as well.
    const rawValues = new URL(req.originalUrl || req.url, "http://localhost").searchParams.getAll("rawTsmf");
    if (rawValues.length > 1 || rawValues.some(value => value !== "true" && value !== "false")) {
        api.responseError(res, 400, "Invalid rawTsmf query");
        return;
    }
    // 未判別TSMFの取得にも使うため、論理format=tlvだけでrawを拒否しない。外側TSの出力機器が前提。
    const rawTsmf = rawValues[0] === "true";
    if (rawTsmf) {
        if (req.query.tsmfRelTs !== undefined || (req.query.format !== undefined && req.query.format !== "ts") || Number(req.query.decode || 0) !== 0) {
            api.responseError(res, 400, "rawTsmf requires TS without decoding or relative stream selection");
            return;
        }
        return api.responseStream(req, res, [], userReq => _.tuner.initChannelStream(channel, userReq, res, undefined, true));
    }

    // the relative streams found by the service scan (the stream as received without specifying, as before, such as for the remote Mirakurun)
    const relTs = req.query.tsmfRelTs !== undefined ? <number> <any> req.query.tsmfRelTs : channel.tsmfRelTs;
    // 設定変更後は受信経路を再確認するまで、未検出の相対TSを推測して開かない。
    if (req.query.tsmfRelTs !== undefined && channel.tsmfRelTs !== relTs && channel.getStreamByRelTs(relTs) === null) {
        api.responseError(res, 404, "Relative Stream Not Found");
        return;
    }

    api.responseStream(
        req,
        res,
        [{ channel, relTs }],
        userReq => _.tuner.initChannelStream(channel, userReq, res, relTs)
    );
};

get.apiDoc = {
    tags: ["channels", "stream"],
    operationId: "getChannelStream",
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
        400: { description: "Invalid parameters, a repeated rawTsmf value, or rawTsmf=true combined with tsmfRelTs, decode=1 or format=tlv" },
        404: {
            description: "Channel or Relative Stream Not Found"
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
