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
import { createReadStream, existsSync } from "fs";
import * as api from "../api";

export const get: Operation = (req, res) => {

    if (!process.env.LOG_STDOUT || !process.env.LOG_STDERR) {
        res.writeHead(500, "Unknown Logfile Path", {
            "Content-Type": "text/plain"
        });
        res.end("Unknown Logfile Path");
        return;
    }
    if (!existsSync(process.env.LOG_STDOUT) || !existsSync(process.env.LOG_STDERR)) {
        res.writeHead(500, "Logfile Unavailable", {
            "Content-Type": "text/plain"
        });
        res.end("Logfile Unavailable");
        return;
    }

    res.writeHead(501, "Not Implemented", {
        "Content-Type": "text/plain"
    });

    res.end("Not Implemented");
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