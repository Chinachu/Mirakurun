/// <reference path="../typings/tsd.d.ts" />
'use strict';

var pkg = require('../package.json');

import net = require('net');
import events = require('events');

import log = require('./log');

export interface IServerConfig {
    id: string;

    path?: string;
    port?: number;
    host?: string;

    tuners: ITuner[];
    tunerGroups: ITunerGroup[];

    logLevel?: log.ELogLevel;
}

export interface ITuner {
    id: string;
    name: string;

    types: EChannelType[];
    groupId?: string;

    // chardev
    command?: string;

    // dvb
    tuneCommand?: string;
    dvbDevicePath?: string;

    isDisabled?: boolean;
}

export interface ITunerGroup {
    id: string;
    name: string;

    controlWait?: number;
}

export enum EChannelType {
    'GR' = 0,
    'BS' = 1,
    'CS' = 2,
    'EX' = 3
}

export function createServer(config: IServerConfig): Server {
    return new Server(config);
}

export class Server extends events.EventEmitter {

    private sockets: net.Server[] = [];

    constructor(public config: IServerConfig) {
        super();

        if (typeof config.logLevel === 'number') {
            log.logLevel = config.logLevel;
        }

        if (config.path) {
            var ipcServer = net.createServer(this.connectionListener.bind(this));

            ipcServer.listen(config.path, function () {
                log.info('opened server on %j', this.address());
            });

            this.sockets.push(ipcServer);
        }

        if (config.port) {
            var extServer = net.createServer(this.connectionListener.bind(this));

            extServer.listen(config.port, config.host, 511, function () {
                log.info('opened server on %j', this.address());
            });

            this.sockets.push(extServer);
        }
    }

    private connectionListener() {

    }
}