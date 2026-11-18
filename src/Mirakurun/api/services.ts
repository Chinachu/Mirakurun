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
import sift from "sift";
import * as api from "../api";
import * as apid from "../../../api";
import _ from "../_";
import Service from "../Service";
import { channelTypes, rejectWhere, WhereQueryError } from "../common";

export const get: Operation = async (req, res, next) => {
    try {
        rejectWhere(req.query);

        const serviceItems = [..._.service.items]; // shallow copy
        serviceItems.sort((a, b) => a.getOrder() - b.getOrder());

        const services: apid.Service[] = [];

        const { "channel.type": channelType, "channel.channel": channelChannel, ...criteria } = req.query;
        // 先頭の経路だけでなく、同じ受信経路が種別とチャンネル名の両条件に一致するか確認する。
        const matchesChannel = channelType !== undefined || channelChannel !== undefined ? sift({
            ...(channelType !== undefined ? { type: channelType } : {}),
            ...(channelChannel !== undefined ? { channel: channelChannel } : {})
        }) : null;
        for (const serviceItem of serviceItems.filter(sift(criteria))) {
            if (matchesChannel && !serviceItem.channels.some(matchesChannel)) { continue; }
            const service = serviceItem.export();
            service.hasLogoData = await Service.isLogoDataExists(serviceItem.networkId, serviceItem.logoId);
            services.push(service);
        }

        api.responseJSON(res, services);
    } catch (err) {
        if (err instanceof WhereQueryError) {
            api.responseError(res, 400);
            return;
        }
        next(err);
    }
};

get.apiDoc = {
    tags: ["services"],
    operationId: "getServices",
    description: "channel.type と channel.channel は、受信可能な同じ経路が両方の条件に一致するサービスを返します。片方だけの指定も可能です。",
    parameters: [
        {
            in: "query",
            name: "serviceId",
            type: "integer",
            required: false
        },
        {
            in: "query",
            name: "networkId",
            type: "integer",
            required: false
        },
        {
            in: "query",
            name: "name",
            type: "string",
            required: false
        },
        {
            in: "query",
            name: "type",
            type: "integer",
            required: false
        },
        {
            in: "query",
            name: "channel.type",
            type: "string",
            enum: channelTypes,
            required: false
        },
        {
            in: "query",
            name: "channel.channel",
            type: "string",
            required: false
        }
    ],
    responses: {
        200: {
            description: "OK",
            schema: {
                type: "array",
                items: {
                    $ref: "#/definitions/Service"
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
