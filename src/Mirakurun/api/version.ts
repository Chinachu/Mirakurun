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
import * as latestVersion from "latest-version";
import * as api from "../api";
import { Version } from "../../../api";
const pkg = require("../../../package.json");

export const get: Operation = async (req, res) => {

    const version: Version = {
        current: pkg.version,
        latest: await latestVersion("mirakurun")
    };

    api.responseJSON(res, version);
};

get.apiDoc = {
    tags: ["version"],
    operationId: "checkVersion",
    responses: {
        200: {
            description: "OK",
            schema: {
                $ref: "#/definitions/Version"
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
