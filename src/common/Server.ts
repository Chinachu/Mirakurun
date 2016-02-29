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

import common = require('../common');
import log = require('../log');
import events = require('events');
import fs = require('fs');
import http = require('http');
import express = require('express');
import swaggerize = require('swaggerize-express');
import morgan = require('morgan');
import bodyParser = require('body-parser');
import yaml = require('js-yaml');

var pkg = require('../../package.json');

class Server extends events.EventEmitter {

    config = common.config.getServer();

    tuner = new common.Tuner();

    private servers: http.Server[] = [];

    constructor() {
        super();

        var config = this.config;

        if (typeof config.logLevel === 'number') {
            log.logLevel = config.logLevel;
        }

        var addresses: string[] = [];

        if (config.path) {
            addresses.push(config.path);
        }

        if (config.port) {
            addresses = addresses.concat(common.util.getPrivateIPv4Addresses().concat(['127.0.0.1']));
        }

        addresses.forEach(address => {

            var app = express();
            var server = http.createServer(app);

            app.disable('x-powered-by');

            app.use(morgan('combined'));
            app.use(bodyParser.urlencoded({ extended: false }));
            app.use(bodyParser.json());

            app.use((req: express.Request, res: express.Response, next) => {

                if (common.regexp.privateIPv4Address.test(req.ip) === true) {
                    res.setHeader('Server', 'Mirakurun/' + pkg.version);
                    next();
                } else {
                    res.status(403).end();
                }
            });

            app.use(swaggerize({
                api: yaml.safeLoad(fs.readFileSync('apiDefinition.yml', 'utf8')),
                docspath: '/docs',
                handlers: '../api'
            }));

            app.use((err, req, res: express.Response, next) => {

                console.error(err.stack);
                console.error(JSON.stringify(err, null, '  '));

                res.json({
                    code: res.statusCode,
                    reason: '@' + err.toString()
                });
            });

            if (/^\//.test(address) === true) {
                if (fs.existsSync(address) === true) {
                    fs.unlinkSync(address);
                }

                server.listen(address, () => {
                    log.info('listening on http://unix:%s', address);
                });
            } else {
                server.listen(config.port, address, () => {
                    log.info('listening on http://%s:%d', address, config.port);
                });
            }

            this.servers.push(server);
        });
    }
}

export = Server;