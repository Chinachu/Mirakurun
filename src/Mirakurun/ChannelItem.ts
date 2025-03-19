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
import * as log from "./log";
import * as common from "./common";
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

        if (!config.serviceId) {
            setTimeout(() => {
                if (this.getServices().length === 0) {
                    _.job.add({
                        key: `ServiceScan.Add.${this.type}.${this.channel}`,
                        name: `Service Scan (Discovery) ${this.type}/${this.channel}`,
                        fn: async () => this._serviceScan(true),
                        readyFn: () => _.tuner.readyForJob(this),
                        retryOnFail: true,
                        retryMax: (1000 * 60 * 60 * 12) / (1000 * 60 * 3), // (12時間 / retryDelay) = 12時間～
                        retryDelay: 1000 * 60 * 3
                    });
                }
            }, 1000 * 5);
        }

        _.job.addSchedule({
            key: `ServiceScan.Update.${this.type}.${this.channel}`,
            schedule: "5 6 * * *", // todo: config
            job: {
                key: `ServiceScan.Update.${this.type}.${this.channel}`,
                name : `Service Scan (Update) ${this.type}/${this.channel}`,
                fn: async () => this._serviceScan(false),
                readyFn: () => _.tuner.readyForJob(this)
            }
        });
    }

    addService(serviceId: number): void {
        if (!_.service) {
            process.nextTick(() => this.addService(serviceId));
            return;
        }

        if (_.service.findByChannel(this).some(service => service.serviceId === serviceId) === true) {
            return;
        }

        _.job.add({
            key: `ServiceCheck.${this.type}.${this.channel}.${serviceId}`,
            name: `Service Check ${this.type}/${this.channel}/${serviceId}`,
            fn: async () => {
                log.info("ChannelItem#'%s' serviceId=%d check has started", this.name, serviceId);

                let services: apid.Service[];
                try {
                    services = await _.tuner.getServices(this);
                } catch (e) {
                    log.warn("ChannelItem#'%s' serviceId=%d check has failed [%s]", this.name, serviceId, e);
                    throw new Error("Service check failed");
                }

                const service = services.find(service => service.serviceId === serviceId);
                if (!service) {
                    log.warn("ChannelItem#'%s' serviceId=%d check has failed [no service]", this.name, serviceId);

                    // retry after 1 hour
                    setTimeout(() => this.addService(serviceId), 3600000);
                    return;
                }

                log.debug("ChannelItem#'%s' serviceId=%d: %s", this.name, serviceId, JSON.stringify(service, null, "  "));

                _.service.add(
                    new ServiceItem(this, service.networkId, service.serviceId, service.name, service.type, service.logoId)
                );

                log.info("ChannelItem#'%s' serviceId=%d check has finished", this.name, serviceId);
            },
            readyFn: () => _.tuner.readyForJob(this),
            retryOnFail: true,
            retryMax: (1000 * 60 * 60 * 12) / (1000 * 60 * 3), // (12時間 / retryDelay) = 12時間～
            retryDelay: 1000 * 60 * 3
        });
    }

    getServices(): ServiceItem[] {
        return _.service.findByChannel(this);
    }

    getStream(user: common.User, output: stream.Writable): Promise<TSFilter> {
        return _.tuner.initChannelStream(this, user, output);
    }

    private async _serviceScan(add: boolean): Promise<void> {
        log.info("ChannelItem#'%s' service scan has started", this.name);

        let services: apid.Service[];
        try {
            services = await _.tuner.getServices(this);
        } catch (e) {
            log.warn("ChannelItem#'%s' service scan has failed [%s]", this.name, e);
            throw new Error("Service scan failed");
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
    }
}
