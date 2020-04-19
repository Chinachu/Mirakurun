/*
   Copyright 2017 kanreisa

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
import { spawn } from "child_process";
import * as api from "../api";

export const put: Operation = (req, res) => {

    if (process.env.pm_uptime) {
        const cmd = spawn("mirakurun", ["restart"], {
            detached: true,
            stdio: "ignore"
        });
        cmd.unref();

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.status(202);
        res.end(JSON.stringify({ _cmd_pid: cmd.pid }));
    } else if (process.env.USING_WINSER) {
        const cmd = spawn("cmd", ["/c", "net stop mirakurun & sc start mirakurun"], {
            detached: true,
            stdio: "ignore"
        });
        cmd.unref();

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.status(202);
        res.end(JSON.stringify({ _cmd_pid: cmd.pid }));
    } else {
        api.responseError(res, 500);
    }
};

put.apiDoc = {
    tags: ["misc"],
    operationId: "restart",
    produces: [
        "application/json"
    ],
    responses: {
        202: {
            description: "Accepted"
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
