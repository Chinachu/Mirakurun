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
        name: "key",
        type: "string",
        required: true
    }
];

export const put: Operation = (req, res) => {
    const key = req.params.key as string;

    if (_.job.schedules.find(s => s.key === key) === null) {
        api.responseError(res, 404);
        return;
    }

    try {
        _.job.runSchedule(key);

        res.status(202);
        res.end();
        return;
    } catch (e) {
        if (e instanceof Error) {
            api.responseError(res, 500, e.message);
            return;
        }

        api.responseError(res, 500);
    }
};

put.apiDoc = {
    tags: ["job"],
    summary: "Request to run a job schedule",
    operationId: "runJobSchedule",
    responses: {
        202: {
            description: "Requested"
        },
        404: {
            description: "Not Found",
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
