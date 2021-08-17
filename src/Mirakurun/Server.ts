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
import * as ip from "ip";
import * as express from "express";
import * as cors from "cors";
import * as openapi from "express-openapi";
import * as morgan from "morgan";
import * as yaml from "js-yaml";
import { OpenAPIV2 } from "openapi-types";
import RPCServer from "jsonrpc2-ws/lib/server";
import { sleep } from "./common";
import * as log from "./log";
import * as system from "./system";
import regexp from "./regexp";
import _ from "./_";
import { createRPCServer, initRPCNotifier } from "./rpc";

const pkg = require("../../package.json");

class Server {

    private _isRunning = false;
    private _servers = new Set<http.Server>();
    private _rpcs = new Set<RPCServer>();

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

        const corsOptions: cors.CorsOptions = {
            origin: (origin, callback) => {
                if (!origin) {
                    return callback(null, true);
                }
                if (isPermittedHost(origin, serverConfig.hostname)) {
                    return callback(null, true);
                }
                return callback(new Error("Not allowed by CORS"));
            }
        };
        app.use(cors(corsOptions));

        app.use(morgan(":remote-addr :remote-user :method :url HTTP/:http-version :status :res[content-length] - :response-time ms :user-agent", {
            stream: log.event as any
        }));
        app.use(express.urlencoded({ extended: false }));
        app.use(express.json());

        app.use((req: express.Request, res: express.Response, next) => {

            if (req.ip && ip.isPrivate(req.ip) === false) {
                req.socket.end();
                return;
            }

            if (req.get("Origin") !== undefined) {
                if (!isPermittedHost(req.get("Origin"), serverConfig.hostname)) {
                    res.status(403).end();
                    return;
                }
            }

            if (req.get("Referer") !== undefined) {
                if (!isPermittedHost(req.get("Referer"), serverConfig.hostname)) {
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
        app.use("/@fluentui/react", express.static("node_modules/@fluentui/react"));

        if (fs.existsSync("node_modules/swagger-ui-dist") === true) {
            app.use("/swagger-ui", express.static("node_modules/swagger-ui-dist"));
            app.get("/api/debug", (req, res) => res.redirect("/swagger-ui/?url=/api/docs"));
        }

        const api = yaml.load(fs.readFileSync("api.yml", "utf8")) as OpenAPIV2.Document;
        api.info.version = pkg.version;

        openapi.initialize({
            app: app,
            apiDoc: api,
            docsPath: "/docs",
            paths: "./lib/Mirakurun/api"
        });

        app.use((err, req, res: express.Response, next) => {

            if (err.message === "Not allowed by CORS") {
                res.status(403).end();
                return;
            }

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

            this._servers.add(server);
            this._rpcs.add(createRPCServer(server));
        });

        // event notifications for RPC
        initRPCNotifier(this._rpcs);

        log.info("RPC interface is enabled");
    }
}

export function isPermittedHost(url: string, allowedHostname?: string): boolean {

    const u = new URL(url);

    if (u.hostname === "localhost" || u.hostname === allowedHostname || ip.isPrivate(u.hostname) === true) {
        return true;
    }

    return false;
}

export default Server;
