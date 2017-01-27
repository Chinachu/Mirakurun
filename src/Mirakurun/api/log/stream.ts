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
import * as fs from "fs";
import * as api from "../../api";
import { Tail } from "tail";

export const get: Operation = (req, res) => {

    if (!process.env.LOG_STDOUT || !process.env.LOG_STDERR) {
        res.writeHead(500, "Unknown Logfile Path", {
            "Content-Type": "text/plain"
        });
        res.end("Unknown Logfile Path");
        return;
    }
    if (!fs.existsSync(process.env.LOG_STDOUT) || !fs.existsSync(process.env.LOG_STDERR)) {
        res.writeHead(500, "Logfile Unavailable", {
            "Content-Type": "text/plain"
        });
        res.end("Logfile Unavailable");
        return;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);

    const stdout = new Tail(process.env.LOG_STDOUT);
    const stderr = new Tail(process.env.LOG_STDERR);

    req.setTimeout(1000 * 60 * 60, () => { });
    req.once("close", () => {
        stdout.removeListener("line", _listener);
        stdout.unwatch();
        stderr.removeListener("line", _listener);
        stderr.unwatch();
    });

    stdout.on("line", _listener);
    stderr.on("line", _listener);

    function _listener(data: string) {
        res.write(data + "\n");
    }
};

get.apiDoc = {
    tags: ["log", "stream"],
    operationId: "getLogStream",
    responses: {
        200: {
            description: "OK"
        },
        default: {
            description: "Unexpected Error"
        }
    }
};