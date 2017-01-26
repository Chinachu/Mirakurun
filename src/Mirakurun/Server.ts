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

import * as fs from "fs";
import * as http from "http";
import * as ip from "ip";
import * as express from "express";
import * as openapi from "express-openapi";
import * as morgan from "morgan";
import * as bodyParser from "body-parser";
import * as yaml from "js-yaml";
import * as log from "./log";
import regexp from "./regexp";
import system from "./system";
import _ from "./_";

const pkg = require("../../package.json");

class Server {

    private _servers: http.Server[] = [];

    constructor() {

        const serverConfig = _.config.server;

        let addresses: string[] = [];

        if (serverConfig.path) {
            addresses.push(serverConfig.path);
        }

        if (serverConfig.port) {
            addresses = [
                ...addresses,
                ...system.getPrivateIPv4Addresses(),
                "127.0.0.1"
            ];

            if (serverConfig.disableIPv6 !== true) {
                addresses = [
                    ...addresses,
                    ...system.getPrivateIPv6Addresses(),
                    "::1"
                ];
            }
        }

        const app = express();

        app.disable("x-powered-by");

        app.use(morgan(":remote-addr :remote-user :method :url HTTP/:http-version :status :res[content-length] - :response-time ms :user-agent"));
        app.use(bodyParser.urlencoded({ extended: false }));
        app.use(bodyParser.json());

        app.use((req: express.Request, res: express.Response, next) => {

            if (
                (req.ip && ip.isPrivate(req.ip) === true) ||
                req.get("Origin") !== undefined ||
                req.get("Referer") !== undefined
            ) {
                res.status(403).end();
                return;
            }

            res.setHeader("Server", "Mirakurun/" + pkg.version);
            next();
        });

        const api = yaml.safeLoad(fs.readFileSync("api.yml", "utf8"));
        api.info.version = pkg.version;

        openapi.initialize({
            app: app,
            apiDoc: api,
            docsPath: "/docs",
            paths: "./lib/Mirakurun/api"
        });

        app.use((err, req, res: express.Response, next) => {

            log.error(JSON.stringify(err, null, "  "));
            console.error(err.stack);

            if (res.headersSent === false) {
                res.writeHead(err.status || 500, {
                    "Content-Type": "application/json"
                });
            }

            res.end(JSON.stringify({
                code: res.statusCode,
                reason: err.message || res.statusMessage,
                errors: err.errors
            }));

            next();
        });

        addresses.forEach(address => {

            const server = http.createServer(app);

            server.timeout = 1000 * 60 * 3; // 3 minutes

            if (regexp.unixDomainSocket.test(address) === true || regexp.windowsNamedPipe.test(address) === true) {
                if (process.platform !== "win32" && fs.existsSync(address) === true) {
                    fs.unlinkSync(address);
                }

                server.listen(address, () => {
                    log.info("listening on http+unix://%s", address.replace(/\//g, "%2F"));
                });

                if (process.platform !== "win32") {
                    fs.chmodSync(address, "777");
                }
            } else {
                server.listen(serverConfig.port, address, () => {
                    if (address.indexOf(":") !== -1) {
                        const pair = address.split("%");
                        const addr = pair[0];
                        const iface = pair[1];
                        log.info("listening on http://[%s]:%d (%s)", addr, serverConfig.port, iface);
                    } else {
                        log.info("listening on http://%s:%d", address, serverConfig.port);
                    }
                });
            }

            this._servers.push(server);
        });
    }
}

export default Server;