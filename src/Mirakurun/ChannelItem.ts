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
import * as stream from "stream";
import _ from "./_";
import queue from "./queue";
import * as db from "./db";
import * as log from "./log";
import * as common from "./common";
import * as config from "./config";
import ServiceItem from "./ServiceItem";
import { StreamFilter } from "./StreamFilter";

export default class ChannelItem {

    private _name: string;
    private _type: common.ChannelType;
    private _channel: string;
    private _satellite: string;
    private _space: number;
    private _freq: number;
    private _polarity: "H" | "V";
    private _tsmfRelTs: number;

    constructor(config: config.Channel) {

        this._name = config.name;
        this._type = config.type;
        this._channel = config.channel;
        this._satellite = config.satellite;
        this._space = config.space;
        this._freq = config.freq;
        this._polarity = config.polarity;
        this._tsmfRelTs = config.tsmfRelTs;

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

    get satellite(): string {
        return this._satellite;
    }

    get space(): number {
        return this._space;
    }

    get freq(): number {
        return this._freq;
    }

    get polarity(): "H" | "V" {
        return this._polarity;
    }

    get tsmfRelTs(): number {
        return this._tsmfRelTs;
    }

    toJSON(): config.Channel {
        return {
            type: this._type,
            channel: this._channel,
            name: this._name,
            satellite: this._satellite,
            space: this._space,
            freq: this._freq,
            polarity: this._polarity,
            tsmfRelTs: this._tsmfRelTs
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

        log.debug("ChannelItem#'%s' serviceId=%d check has queued", this._name, serviceId);

        queue.add(async () => {

            log.info("ChannelItem#'%s' serviceId=%d check has started", this._name, serviceId);

            let services;
            try {
                services = await _.tuner.getServices(this);
            } catch (e) {
                log.warn("ChannelItem#'%s' serviceId=%d check has failed [%s]", this._name, serviceId, e);

                setTimeout(() => this.addService(serviceId), 180000);
                return;
            }

            const service = services.find(service => service.serviceId === serviceId);
            if (!service) {
                log.warn("ChannelItem#'%s' serviceId=%d check has failed [no service]", this._name, serviceId);

                setTimeout(() => this.addService(serviceId), 3600000);
                return;
            }

            log.debug("ChannelItem#'%s' serviceId=%d: %s", this._name, serviceId, JSON.stringify(service, null, "  "));

            _.service.add(
                new ServiceItem(this, service.networkId, service.serviceId, service.name, service.type, service.logoId)
            );
        });
    }

    getServices(): ServiceItem[] {
        return _.service.findByChannel(this);
    }

    getStream(user: common.User, output: stream.Writable): Promise<StreamFilter> {
        return _.tuner.initChannelStream(this, user, output);
    }

    serviceScan(add: boolean): void {

        log.debug("ChannelItem#'%s' service scan has queued", this._name);

        queue.add(async () => {

            log.info("ChannelItem#'%s' service scan has started", this._name);

            let services: db.Service[];
            try {
                services = await _.tuner.getServices(this);
            } catch (e) {
                log.warn("ChannelItem#'%s' service scan has failed [%s]", this._name, e);

                setTimeout(() => this.serviceScan(add), add ? 180000 : 3600000);
                return;
            }

            log.debug("ChannelItem#'%s' services: %s", this._name, JSON.stringify(services, null, "  "));

            services.forEach(service => {

                const item = _.service.get(service.networkId, service.serviceId);
                if (item !== null) {
                    item.name = service.name;
                    item.type = service.type;
                    if (service.logoId > -1) {
                        item.logoId = service.logoId;
                    }
                    item.remoteControlKeyId = service.remoteControlKeyId;
                } else if (add === true) {
                    _.service.add(
                        new ServiceItem(
                            this,
                            service.networkId,
                            service.serviceId,
                            service.name,
                            service.type,
                            service.logoId,
                            service.remoteControlKeyId
                        )
                    );
                }
            });

            log.info("ChannelItem#'%s' service scan has finished", this._name);
        });
    }
}
