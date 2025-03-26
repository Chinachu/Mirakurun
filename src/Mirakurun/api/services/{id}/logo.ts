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
import _ from "../../../_";
import Service from "../../../Service";

export const parameters = [
    {
        in: "path",
        name: "id",
        type: "integer",
        maximum: 6553565535,
        required: true
    }
];

export const get: Operation = async (req, res) => {
    const service = _.service.get(req.params.id as any as number);

    if (service === null || service === undefined) {
        res.writeHead(404, "Not Found");
        res.end();
        return;
    }

    if (typeof service.logoId !== "number" || service.logoId < 0) {
        res.writeHead(503, "Logo Data Unavailable");
        res.end();
        return;
    }

    const logoData = await Service.loadLogoData(service.networkId, service.logoId);
    if (logoData) {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.status(200);
        res.end(logoData);
    } else {
        res.writeHead(503, "Logo Data Unavailable");
        res.end();
    }
};

get.apiDoc = {
    tags: ["services"],
    operationId: "getLogoImage",
    produces: ["image/png"],
    responses: {
        200: {
            description: "OK"
        },
        404: {
            description: "Not Found"
        },
        503: {
            description: "Logo Data Unavailable"
        },
        default: {
            description: "Unexpected Error"
        }
    }
};
