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
import * as fs from "fs";
import * as http from "http";
import * as url from "url";
import * as ip from "ip";
import * as express from "express";
import * as openapi from "express-openapi";
import * as morgan from "morgan";
import * as bodyParser from "body-parser";
import * as yaml from "js-yaml";
import { OpenAPIV2 } from "openapi-types";
import { sleep } from "./common";
import * as log from "./log";
import * as system from "./system";
import regexp from "./regexp";
import _ from "./_";

const pkg = require("../../package.json");

class Server {

    private _isRunning = false;
    private _servers: http.Server[] = [];

    async init() {

        if (this._isRunning === true) {
            throw new Error("Server is running");
        }
        this._isRunning = true;

        const serverConfig = _.config.server;

        let addresses: string[] = [];

        if (serverConfig.path) {
            addresses.push(serverConfig.path);
        }

        if (serverConfig.port) {
            while (true) {
                try {
                    if (system.getPrivateIPv4Addresses().length > 0) {
                        break;
                    }
                } catch (e) {
                    console.error(e);
                }
                log.warn("Server hasn't detected IPv4 addresses...");
                await sleep(5000);
            }

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

        app.use(morgan(":remote-addr :remote-user :method :url HTTP/:http-version :status :res[content-length] - :response-time ms :user-agent", {
            stream: log.event as any
        }));
        app.use(bodyParser.urlencoded({ extended: false }));
        app.use(bodyParser.json());

        app.use((req: express.Request, res: express.Response, next) => {

            if (req.ip && ip.isPrivate(req.ip) === false) {
                req.socket.end();
                return;
            }

            if (req.get("Origin") !== undefined) {
                const origin = url.parse(req.get("Origin"));
                if (origin.hostname !== "localhost" && origin.hostname !== serverConfig.hostname && ip.isPrivate(origin.hostname) === false) {
                    res.status(403).end();
                    return;
                }
            }

            if (req.get("Referer") !== undefined) {
                const referer = url.parse(req.get("Referer"));
                if (referer.hostname !== "localhost" && referer.hostname !== serverConfig.hostname && ip.isPrivate(referer.hostname) === false) {
                    res.status(403).end();
                    return;
                }
            }

            res.setHeader("Server", "Mirakurun/" + pkg.version);
            next();
        });

        app.use(express.static("lib/ui", {
            setHeaders: (res, path) => {
                if ((<any> express.static.mime).lookup(path) === "image/svg+xml") {
                    res.setHeader("Cache-Control", "public, max-age=86400");
                }
            }
        }));
        app.use("/eventemitter3", express.static("node_modules/eventemitter3"));
        app.use("/react", express.static("node_modules/react"));
        app.use("/react-dom", express.static("node_modules/react-dom"));
        app.use("/office-ui-fabric-react", express.static("node_modules/office-ui-fabric-react"));

        if (fs.existsSync("node_modules/swagger-ui-dist") === true) {
            app.use("/swagger-ui", express.static("node_modules/swagger-ui-dist"));
            app.get("/api/debug", (req, res) => res.redirect("/swagger-ui/?url=/api/docs"));
        }

        const api = yaml.safeLoad(fs.readFileSync("api.yml", "utf8")) as OpenAPIV2.Document;
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

            server.timeout = 1000 * 15; // 15 sec.

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
                    if (address.includes(":") === true) {
                        const [addr, iface] = address.split("%");
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
