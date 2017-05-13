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
import * as api from "../../../api";
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

export const get: Operation = (req, res) => {

    const service = Service.get(req.params.id);

    if (service === null || service === undefined) {
        res.writeHead(404, "Not Found");
        res.end();
        return;
    }

    if (service.hasLogoData === false) {
        res.writeHead(503, "Logo Data Unavailable");
        res.end();
        return;
    }

    res.setHeader("Content-Type", "image/png");
    res.status(200);
    res.end(service.logoData);
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
