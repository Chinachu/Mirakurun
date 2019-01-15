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
import { join } from "path";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { Tail } from "tail";
import * as latestVersion from "latest-version";
import * as api from "../../api";
const current = require("../../../../package.json").version as string;

export const put: Operation = async (req, res) => {

    if (!req.query.force && !process.env.pm_uptime && !process.env.USING_WINSER) {
        api.responseError(res, 500);
        return;
    }

    const latest = await latestVersion("mirakurun");

    if (!req.query.force && current === latest) {
        api.responseError(res, 409, "Update Nothing");
        return;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(202);
    res.write("Updating...\n");

    const path = join(tmpdir(), "Mirakurun_Updating.log");

    res.write(`> node lib/updater\n\n`);

    const env = JSON.parse(JSON.stringify(process.env));
    env.UPDATER_LOG_PATH = path;

    const npm = spawn("node", ["lib/updater"], {
        detached: true,
        stdio: "ignore",
        env
    });
    npm.unref();

    const tail = new Tail(path);
    tail.on("line", data => res.write(data + "\n"));

    req.once("close", () => {
        tail.removeAllListeners("line");
        tail.unwatch();
    });
};

put.apiDoc = {
    tags: ["version"],
    operationId: "updateVersion",
    produces: [
        "text/plain",
        "application/json"
    ],
    parameters: [
        {
            in: "query",
            name: "force",
            type: "boolean",
            required: false
        }
    ],
    responses: {
        202: {
            description: "Accepted"
        },
        409: {
            description: "Update Nothing",
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
