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
import * as apid from "../../api";
import ServiceItem from "./ServiceItem";
import TSFilter from "./TSFilter";

export default class ChannelItem {
    readonly name: string;
    readonly type: apid.ChannelType;
    readonly channel: string;
    readonly tsmfRelTs: number;
    readonly commandVars: apid.ConfigChannelsItem["commandVars"];

    constructor(config: apid.ConfigChannelsItem) {
        this.name = config.name;
        this.type = config.type;
        this.channel = config.channel;
        this.tsmfRelTs = config.tsmfRelTs;
        this.commandVars = config.commandVars;

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

    addService(serviceId: number): void {
        if (!_.service) {
            process.nextTick(() => this.addService(serviceId));
            return;
        }

        if (_.service.findByChannel(this).some(service => service.serviceId === serviceId) === true) {
            return;
        }

        log.debug("ChannelItem#'%s' serviceId=%d check has queued", this.name, serviceId);

        queue.add(async () => {
            log.info("ChannelItem#'%s' serviceId=%d check has started", this.name, serviceId);

            let services;
            try {
                services = await _.tuner.getServices(this);
            } catch (e) {
                log.warn("ChannelItem#'%s' serviceId=%d check has failed [%s]", this.name, serviceId, e);

                setTimeout(() => this.addService(serviceId), 180000);
                return;
            }

            const service = services.find(service => service.serviceId === serviceId);
            if (!service) {
                log.warn("ChannelItem#'%s' serviceId=%d check has failed [no service]", this.name, serviceId);

                setTimeout(() => this.addService(serviceId), 3600000);
                return;
            }

            log.debug("ChannelItem#'%s' serviceId=%d: %s", this.name, serviceId, JSON.stringify(service, null, "  "));

            _.service.add(
                new ServiceItem(this, service.networkId, service.serviceId, service.name, service.type, service.logoId)
            );
        });
    }

    getServices(): ServiceItem[] {
        return _.service.findByChannel(this);
    }

    getStream(user: common.User, output: stream.Writable): Promise<TSFilter> {
        return _.tuner.initChannelStream(this, user, output);
    }

    serviceScan(add: boolean): void {
        log.debug("ChannelItem#'%s' service scan has queued", this.name);

        queue.add(async () => {
            log.info("ChannelItem#'%s' service scan has started", this.name);

            let services: apid.Service[];
            try {
                services = await _.tuner.getServices(this);
            } catch (e) {
                log.warn("ChannelItem#'%s' service scan has failed [%s]", this.name, e);

                setTimeout(() => this.serviceScan(add), add ? 180000 : 3600000);
                return;
            }

            log.debug("ChannelItem#'%s' services: %s", this.name, JSON.stringify(services, null, "  "));

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

            log.info("ChannelItem#'%s' service scan has finished", this.name);
        });
    }
}
