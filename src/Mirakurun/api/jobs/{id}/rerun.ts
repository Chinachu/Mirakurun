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
        name: "id",
        type: "string",
        required: true
    }
];

export const put: Operation = (req, res) => {
    const id = req.params.id as string;

    if (_.job.rerun(id)) {
        res.status(202);
        res.end();
        return;
    } else {
        api.responseError(res, 409, "job is missing or already been abort requested or other unacceptable state");
        return;
    }
};

put.apiDoc = {
    tags: ["job"],
    summary: "Request to rerun a job",
    operationId: "rerunJob",
    responses: {
        202: {
            description: "Requested"
        },
        409: {
            description: "Conflict",
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
