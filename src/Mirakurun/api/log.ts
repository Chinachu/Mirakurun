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
import { event } from "../log";

export const get: Operation = (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);

    const logs = event.logs;
    const len = logs.length;
    for (let i = 0; i < len; i++) {
        res.write(logs[i] + "\n");
    }

    res.end();
};

get.apiDoc = {
    tags: ["log"],
    operationId: "getLog",
    produces: ["text/plain"],
    responses: {
        200: {
            description: "OK"
        },
        default: {
            description: "Unexpected Error"
        }
    }
};
