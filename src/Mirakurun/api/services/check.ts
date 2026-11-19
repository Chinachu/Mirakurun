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
import * as apid from "../../../../api";
import _ from "../../_";

export const put: Operation = (req, res) => {
    const body = (req.body || {}) as apid.ServiceCheckRequest;

    let results: apid.ServiceCheckResultItem[];

    if (Array.isArray(body.targets)) {
        results = body.targets.map((target): apid.ServiceCheckResultItem => {
            const result: apid.ServiceCheckResultItem = {
                type: target.type,
                channel: target.channel,
                serviceId: target.serviceId,
                status: "notConfigured"
            };

            const channel = _.channel.get(target.type, target.channel);
            if (channel !== null) {
                result.status = _.service.requestCheckToAdd(channel, target.serviceId);
            }

            if (result.status === "queued") {
                result.jobKey = `Service.Add.Check.${target.type}.${target.channel}.${target.serviceId}`;
            }

            return result;
        });
    } else {
        results = _.service.requestCheckToAddAll().map((target): apid.ServiceCheckResultItem => ({
            type: target.type,
            channel: target.channel,
            serviceId: target.serviceId,
            status: "queued",
            jobKey: `Service.Add.Check.${target.type}.${target.channel}.${target.serviceId}`
        }));
    }

    const response: apid.ServiceCheckResult = { results };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(202);
    res.end(JSON.stringify(response));
};

put.apiDoc = {
    tags: ["services"],
    summary: "Request to check for services that are in the channel config but not registered yet",
    operationId: "checkServices",
    parameters: [
        {
            in: "body",
            name: "body",
            required: false,
            schema: {
                $ref: "#/definitions/ServiceCheckRequest"
            }
        }
    ],
    responses: {
        202: {
            description: "Accepted",
            schema: {
                $ref: "#/definitions/ServiceCheckResult"
            }
        },
        400: {
            description: "Bad Request",
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
