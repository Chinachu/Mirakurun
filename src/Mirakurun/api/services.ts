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
import sift from "sift";
import * as api from "../api";
import Service from "../Service";
import ServiceItem from "../ServiceItem";
import { ChannelTypes } from "../common";

export const get: Operation = (req, res) => {

    const services = Service.all().map(service => {

        const ret: any = service.export();
        ret.hasLogoData = service.hasLogoData;

        return ret;
    });

    services.sort((a: ServiceItem, b: ServiceItem) => getOrder(a) - getOrder(b));

    api.responseJSON(res, sift(req.query, services));
};

function getOrder(service: ServiceItem): number {

    let order: string;

    switch (service.channel.type) {
        case "GR":
            order = "1";
            break;
        case "BS":
            order = "2";
            break;
        case "CS":
            order = "3";
            break;
        case "SKY":
            order = "4";
            break;
    }

    if (service.remoteControlKeyId) {
        order += (100 + service.remoteControlKeyId).toString(10);
    } else {
        order += "200";
    }

    order += (10000 + service.serviceId).toString(10);

    return parseInt(order, 10);
}

get.apiDoc = {
    tags: ["services"],
    operationId: "getServices",
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
            enum: Object.keys(ChannelTypes),
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
