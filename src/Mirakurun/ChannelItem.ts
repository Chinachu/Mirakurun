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

import * as stream from "stream";
import _ from "./_";
import queue from "./queue";
import * as log from "./log";
import * as common from "./common";
import * as config from "./config";
import ServiceItem from "./ServiceItem";

export default class ChannelItem {

    private _name: string;
    private _type: common.ChannelType;
    private _channel: string;
    private _satelite: string;

    constructor(config: config.Channel) {

        const pre = _.channel.get(config.type, config.channel);
        if (pre !== null) {
            if (config.serviceId) {
                pre.addService(config.serviceId);
            }

            return pre;
        }

        this._name = config.name;
        this._type = config.type;
        this._channel = config.channel;
        this._satelite = config.satelite;

        if (config.serviceId) {
            this.addService(config.serviceId);
        }

        setTimeout(() => {
            if (!config.serviceId && this.getServices().length === 0) {
                this.serviceScan(true);
            } else {
                setTimeout(() => this.serviceScan(false), 180000);
            }
        }, 3000);

        _.channel.add(this);
    }

    get name(): string {
        return this._name;
    }

    get type(): common.ChannelType {
        return this._type;
    }

    get channel(): string {
        return this._channel;
    }

    get satelite(): string {
        return this._satelite;
    }

    export(): config.Channel {
        return {
            type: this._type,
            channel: this._channel,
            name: this._name,
            satelite: this._satelite
        };
    }

    addService(serviceId: number): void {

        if (!_.service) {
            process.nextTick(() => this.addService(serviceId));
            return;
        }

        if (_.service.findByChannel(this).some(service => service.serviceId === serviceId) === true) {
            return;
        }

        log.info("ChannelItem#'%s' serviceId=%d check has queued", this._name, serviceId);

        queue.add(() => {
            return new Promise((resolve, reject) => {

                log.info("ChannelItem#'%s' serviceId=%d check has started", this._name, serviceId);

                _.tuner.getServices(this)
                    .then(services => services.find(service => service.serviceId === serviceId))
                    .then(service => {

                        log.debug("ChannelItem#'%s' serviceId=%d: %s", this._name, serviceId, JSON.stringify(service, null, "  "));

                        new ServiceItem(this, service.networkId, service.serviceId, service.name, service.logoId);

                        resolve();
                    })
                    .catch(error => {

                        log.info("ChannelItem#'%s' serviceId=%d check has failed [%s]", this._name, serviceId, error);

                        setTimeout(() => this.addService(serviceId), 180000);

                        reject();
                    });
            });
        });
    }

    getServices(): ServiceItem[] {
        return _.service.findByChannel(this);
    }

    getStream(user: common.User): Promise<stream.Readable> {
        return _.tuner.getChannelStream(this, user);
    }

    serviceScan(add: boolean): void {

        log.info("ChannelItem#'%s' service scan has queued", this._name);

        queue.add(() => {
            return new Promise((resolve, reject) => {

                log.info("ChannelItem#'%s' service scan has started", this._name);

                _.tuner.getServices(this)
                    .then(services => {

                        log.debug("ChannelItem#'%s' services: %s", this._name, JSON.stringify(services, null, "  "));

                        services.forEach(service => {

                            const item = _.service.get(service.networkId, service.serviceId);
                            if (item !== null) {
                                item.name = service.name;
                                item.logoId = service.logoId;
                                log.debug("Service Item Update: name=%s logoId=%d", service.name, service.logoId);
                            } else if (add === true) {
                                new ServiceItem(this, service.networkId, service.serviceId, service.name, service.logoId);
                            }
                        });

                        log.info("ChannelItem#'%s' service scan has finished", this._name);

                        resolve();
                    })
                    .catch(error => {

                        log.error("ChannelItem#'%s' service scan has failed [%s]", this._name, error);

                        setTimeout(() => this.serviceScan(add), add ? 180000 : 3600000);

                        reject();
                    });
            });
        });
    }
}
