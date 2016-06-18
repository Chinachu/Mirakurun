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
/// <reference path="../../typings/index.d.ts" />
"use strict";

import * as express from "express";

export interface Error {
    code: number;
    reason: string;
    errors: any[]
}

export function responseError(res: express.Response, code: number, reason?: string): express.Response {

    if (reason) {
        res.writeHead(code, reason, {
            "Content-Type": "application/json"
        });
    } else {
        res.writeHead(code, {
            "Content-Type": "application/json"
        });
    }

    var error: Error = {
        code: code,
        reason: reason || null,
        errors: []
    };

    res.end(JSON.stringify(error));

    return res;
}

export function responseStreamErrorHandler(res: express.Response, err: NodeJS.ErrnoException): express.Response {

    if (err.message === "no available tuners") {
        return responseError(res, 503, "Tuner Resource Unavailable");
    }

    return responseError(res, 500, err.message);
}

export function responseJSON(res: express.Response, body: any): express.Response {

    // this is lighter than res.json()
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200);
    res.end(JSON.stringify(body));

    return res;
}