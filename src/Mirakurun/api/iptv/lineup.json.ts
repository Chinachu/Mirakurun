/*
   Copyright 2021 kanreisa

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
import _ from "../../_";

interface HDHRChannel {
    GuideNumber: string;
    GuideName: string;
    HD: 1;
    URL: string;
}

export const get: Operation = (req, res) => {
    const apiRoot = `${req.protocol}://${req.headers.host}/api`;

    const services = [..._.service.items]; // shallow copy
    services.sort((a, b) => a.getOrder() - b.getOrder());

    const channels: HDHRChannel[] = [];

    const countMap = new Map<number, number>();
    for (const service of services) {
        if (service.type !== 1 && service.type !== 173) {
            continue;
        }

        const mainNum = service.remoteControlKeyId || service.serviceId;
        if (countMap.has(mainNum)) {
            countMap.set(mainNum, countMap.get(mainNum) + 1);
        } else {
            countMap.set(mainNum, 1);
        }
        const subNum = countMap.get(mainNum);

        channels.push({
            GuideNumber: `${mainNum}.${subNum}`,
            GuideName: service.name,
            HD: 1,
            URL: `${apiRoot}/services/${service.id}/stream`
        });
    }

    api.responseJSON(res, channels);
};

get.apiDoc = {
    tags: ["iptv"],
    summary: "IPTV - Media Server Support",
    responses: {
        200: {
            description: "OK"
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
