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
"use strict";

import { Operation } from "express-openapi";
import * as api from "../../api";
import { openSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { tmpdir } from "os";
const Tail = require("tail").Tail;
const latestVersion = require("latest-version");
const current = require("../../../../package.json").version as string;

export const put: Operation = (req, res) => {

    if (!req.query.force && !process.env["pm_uptime"] && !process.env["USING_WINSER"]) {
        api.responseError(res, 500);
        return;
    }

    latestVersion("mirakurun").then(latest => {

        if (!req.query.force && current === latest) {
            api.responseError(res, 409, "Update Nothing");
            return;
        }

        let command;
        const args = [
            "install",
            "mirakurun@latest",
            "-g",
            "--production"
        ];
        if (process.platform === "win32") {
            command = "npm.cmd";
        } else {
            command = "npm";
            args.push("--unsafe");
        }

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.status(202);
        res.write("Updating...\n");

        const path = join(tmpdir(), "Mirakurun_Updating.log");
        if (existsSync(path) === true) {
            unlinkSync(path);
        }

        const out = openSync(path, "a");
        const err = openSync(path, "a");

        res.write(`> ${command} ${args.join(" ")}\n\n`);

        const npm = spawn(command, args, {
            detached: true,
            stdio: ["ignore", out, err]
        });
        npm.unref();

        const tail = new Tail(path);
        tail.on("line", data => res.write(data + "\n"));

        req.once("close", () => {
            tail.removeAllListener("line");
            tail.unwatch();
        });
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