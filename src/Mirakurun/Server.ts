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
/// <reference path="../../typings/tsd.d.ts" />
'use strict';

import fs = require('fs');
import http = require('http');
import express = require('express');
import openapi = require('express-openapi');
import morgan = require('morgan');
import bodyParser = require('body-parser');
import yaml = require('js-yaml');
import log = require('./log');
import regexp = require('./regexp');
import config = require('./config');
import system = require('./system');
import Event = require('./Event');
import Tuner = require('./Tuner');
import Channel = require('./Channel');
import Service = require('./Service');
import Program = require('./Program');

const pkg = require('../../package.json');

class Server {

    private _servers: http.Server[] = [];

    constructor() {

        const serverConfig = config.loadServer();

        if (typeof serverConfig.logLevel === 'number') {
            log.logLevel = serverConfig.logLevel;
        }

        const addresses: string[] = [];

        if (serverConfig.path) {
            addresses.push(serverConfig.path);
        }

        if (serverConfig.port) {
            system.getPrivateIPv4Addresses().concat(['127.0.0.1']).forEach((address) => {
                addresses.push(address);
            });
        }

        addresses.forEach(address => {

            const app = express();
            const server = http.createServer(app);

            server.timeout = 1000 * 60 * 3;// 3 minutes

            app.disable('x-powered-by');

            app.use(morgan(':remote-addr :remote-user :method :url HTTP/:http-version :status :res[content-length] - :response-time ms :user-agent'));
            app.use(bodyParser.urlencoded({ extended: false }));
            app.use(bodyParser.json());

            app.use((req: express.Request, res: express.Response, next) => {

                if (regexp.privateIPv4Address.test(req.ip) === true || !req.ip) {
                    res.setHeader('Server', 'Mirakurun/' + pkg.version);
                    next();
                } else {
                    res.status(403).end();
                }
            });

            openapi.initialize({
                app: app,　　　　　　　　　　　　　　　
                apiDoc: yaml.safeLoad(fs.readFileSync('apiDefinition.yml', 'utf8')),
                docsPath: '/docs',
                routes: './lib/Mirakurun/api'
            });

            app.use((err, req, res: express.Response, next) => {

                log.error(JSON.stringify(err, null, '  '));
                console.error(err.stack);

                if (res.headersSent === false) {
                    res.writeHead(err.status, {
                        'Content-Type': 'application/json'
                    });
                }

                res.end(JSON.stringify({
                    code: res.statusCode,
                    reason: err.message || res.statusMessage,
                    errors: err.errors
                }));

                next();
            });

            if (/^\//.test(address) === true) {
                if (fs.existsSync(address) === true) {
                    fs.unlinkSync(address);
                }

                server.listen(address, () => {
                    log.info('listening on http://unix:%s', address);
                });

                fs.chmodSync(address, '777');
            } else {
                server.listen(serverConfig.port, address, () => {
                    log.info('listening on http://%s:%d', address, serverConfig.port);
                });
            }

            this._servers.push(server);
        });

        new Event();
        new Tuner();
        new Channel();
        new Service();
        new Program();
    }
}

export = Server;