/*
   Copyright 2017 kanreisa

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
import { Operation } from "express-openapi";
import * as api from "../../../api";
import * as common from "../../../common";
import * as config from "../../../config";
import * as db from "../../../db";
import Tuner from "../../../Tuner";

let isScanning = false;

const compareOptions = {
    sensitivity: "base",
    numeric: true
};

const channelOrder = {
    GR: 1,
    BS: 2,
    CS: 3,
    SKY: 4
};

enum RegisterMode {
    Channel = "Channel",
    Service = "Service"
}

interface ChannelScanOption {
    type: string;
    startCh?: number;
    endCh?: number;
    startSubCh?: number;
    endSubCh?: number;
    useSubCh?: boolean;
    registerMode?: RegisterMode;
    registerOnDisabled?: boolean;
}

interface ScanConfig {
    readonly channels: string[];
    readonly registerMode: RegisterMode;
    readonly registerOnDisabled: boolean;
}

function range(start: number, end: number): string[] {
    return Array.from({length: (end - start + 1)}, (v, index) => (index + start).toString(10));
}

function generateScanConfig(option: ChannelScanOption): ScanConfig {
    switch (option.type) {
        case common.ChannelTypes.GR:
            option.startCh = option.startCh === undefined ? 13 : option.startCh;
            option.endCh = option.endCh === undefined ? 62 : option.endCh;
            return {
                channels: range(option.startCh, option.endCh).map((ch) => ch),
                registerMode: (option.registerMode === undefined ? RegisterMode.Channel : option.registerMode),
                registerOnDisabled: (option.registerOnDisabled === undefined ? false : option.registerOnDisabled)
            };
        case common.ChannelTypes.BS:
            if (option.useSubCh) {
                option.startCh = option.startCh === undefined ? 1 : option.startCh;
                option.endCh = option.endCh === undefined ? 23 : option.endCh;
                option.startSubCh = option.startSubCh === undefined ? 0 : option.startSubCh;
                option.endSubCh = option.endSubCh === undefined ? 2 : option.endSubCh;

                const channels: string[] = [];
                for (const ch of range(option.startCh, option.endCh)) {
                    for (const subCh of range(option.startSubCh, option.endSubCh)) {
                        channels.push(`BS${ch.toString().padStart(2, "0")}_${subCh}`);
                    }
                }
                return {
                    channels: channels,
                    registerMode: (option.registerMode === undefined ? RegisterMode.Service : option.registerMode),
                    registerOnDisabled: (option.registerOnDisabled === undefined ? true : option.registerOnDisabled)
                };
            }
            option.startCh = option.startCh === undefined ? 101 : option.startCh;
            option.endCh = option.endCh === undefined ? 256 : option.endCh;
            return {
                channels: range(option.startCh, option.endCh).map((ch) => ch),
                registerMode: (option.registerMode === undefined ? RegisterMode.Service : option.registerMode),
                registerOnDisabled: (option.registerOnDisabled === undefined ? true : option.registerOnDisabled)
            };
        case common.ChannelTypes.CS:
            option.startCh = option.startCh === undefined ? 2 : option.startCh;
            option.endCh = option.endCh === undefined ? 24 : option.endCh;
            return {
                channels: range(option.startCh, option.endCh).map((ch) => `CS${ch}`),
                registerMode: (option.registerMode === undefined ? RegisterMode.Service : option.registerMode),
                registerOnDisabled: (option.registerOnDisabled === undefined ? true : option.registerOnDisabled)
            };
    }
}

function generateChannelItemForService(type: common.ChannelType, channel: string, service: db.Service, registerOnDisabled: boolean): config.Channel {

    let name = service.name;
    name = name.trim();
    if (name.length === 0) {
        name = `${type}${channel}:${service.serviceId}`;
    }

    return {
        name: name,
        type: type,
        channel: channel,
        serviceId: service.serviceId,
        isDisabled: registerOnDisabled
    };
}

function generateChannelItemForChannel(type: common.ChannelType, channel: string, services: db.Service[], registerOnDisabled: boolean): config.Channel {

    let name = services[0].name;
    for (const service of services) {
        for (let i = 1; i < name.length && i < service.name.length; i++) {
            if (name[i] !== service.name[i]) {
                name = name.slice(0, i);
                break;
            }
        }
    }
    name = name.trim();
    if (name.length === 0) {
        name = services[0].name || `${type}${channel}`;
    }

    return {
        name: name,
        type: type,
        channel: channel,
        isDisabled: registerOnDisabled
    };
}

function generateChannelItems(type: common.ChannelType, channel: string, services: db.Service[], registerMode: RegisterMode, registerOnDisabled: boolean): config.Channel[] {

    if (registerMode === RegisterMode.Service) {
        const channelItems: config.Channel[] = [];
        for (const service of services) {
            channelItems.push(generateChannelItemForService(type, channel, service, registerOnDisabled));
        }
        return channelItems;
    }

    return [generateChannelItemForChannel(type, channel, services, registerOnDisabled)];
}

export const put: Operation = async (req, res) => {

    if (isScanning === true) {
        api.responseError(res, 409, "Already Scanning");
        return;
    }

    isScanning = true;
    const type = req.query.type as common.ChannelType;
    const minCh = req.query.minCh as any as number;
    const maxCh = req.query.maxCh as any as number;
    const minSubCh = req.query.minSubCh as any as number;
    const maxSubCh = req.query.maxSubCh as any as number;
    const useSubCh = req.query.useSubCh as any as boolean;
    const registerMode = req.query.registerMode as any as RegisterMode;
    const registerOnDisabled = req.query.registerOnDisabled as any as boolean;
    const result: config.Channel[] = config.loadChannels().filter(channel => channel.type !== type);
    let count = 0;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);
    res.write(`channel scanning... (type: "${type}")\n\n`);

    const scanConfig = generateScanConfig({
        type: type,
        startCh: minCh,
        endCh: maxCh,
        startSubCh: minSubCh,
        endSubCh: maxSubCh,
        useSubCh: useSubCh,
        registerMode: registerMode,
        registerOnDisabled: registerOnDisabled
    });

    for (const channel of scanConfig.channels) {
        res.write(`channel: "${channel}" ...\n`);

        let services: db.Service[];
        try {
            services = await Tuner.getServices(<any> {
                type: type,
                channel: channel
            });
        } catch (e) {
            res.write(`-> no signal. [${e}] \n\n`);
            continue;
        }

        services = services.filter(service => service.type === 1);
        res.write(`-> ${services.length} services found.\n`);

        if (services.length === 0) {
            res.write(`\n`);
            continue;
        }

        const channelItems = generateChannelItems(type, channel, services, scanConfig.registerMode, registerOnDisabled);

        for (const channelItem of channelItems) {
            result.push(channelItem);
            ++count;
            res.write(`-> ${JSON.stringify(channelItem)}\n\n`);
        }
    }

    result.sort((a, b) => {
        if (a.type === b.type) {
            return a.channel.localeCompare(b.channel, undefined, compareOptions);
        } else {
            return channelOrder[a.type] - channelOrder[b.type];
        }
    });
    config.saveChannels(result);

    res.write(`-> total ${count} channels found and ${result.length} channels stored.\n\n`);

    isScanning = false;

    res.write(`channel scan has completed and saved successfully.\n`);
    res.write(`**RESTART REQUIRED** to apply changes.\n`);

    res.end();
};

put.apiDoc = {
    description: "Scan the receivable channels and rewrite the channel settings. \n\n\
Note: \n\
- Note that running a scan clears all original channel entries of the specified type. Other types of channel entries are unchanged. \n\
- Only when scanning BS, you can specify the channel number in the subchannel style (e.g. BS01_0). To specify the channel number, use minSubCh and maxSubCh in addition to minCh and maxCh. \n\
- The subchannel number parameters (minSubCh, maxSubCh) are used only if the type is BS and are ignored otherwise. \n\
- Subchannel style scans scan in the following range: \n\
    From `BS${minCh}_${minSubCh}` to `BS${maxCh}_${maxSubCh}` \n\
- In the subchannel style, minCh and maxCh are zero padded to two digits. minSubCh and maxSubCh are not padded. \n\
- BS \"non\" subchannel style scans and GR scans are basically the same. Note that if you scan the wrong channel range, the GR channel will be registered as BS and the BS channel will be registered as GR. This problem does not occur because CS scan uses a character string with `CS` added as a channel number prefix.",
    tags: ["config"],
    operationId: "channelScan",
    produces: [
        "text/plain",
        "application/json"
    ],
    parameters: [
        {
            in: "query",
            name: "type",
            type: "string",
            enum: [common.ChannelTypes.GR, common.ChannelTypes.BS, common.ChannelTypes.CS],
            default: common.ChannelTypes.GR,
            description: "Specifies the channel type to scan."
        },
        {
            in: "query",
            name: "minCh",
            type: "integer",
            description: "Specifies the minimum number of channel numbers to scan."
        },
        {
            in: "query",
            name: "maxCh",
            type: "integer",
            description: "Specifies the maximum number of channel numbers to scan."
        },
        {
            in: "query",
            name: "minSubCh",
            type: "integer",
            description: "Specifies the minimum number of subchannel numbers to scan. This parameter is only used if the type is `BS` and the bs_subch_style is `true`."
        },
        {
            in: "query",
            name: "maxSubCh",
            type: "integer",
            description: "Specifies the maximum number of subchannel numbers to scan. This parameter is only used if the type is `BS` and the bs_subch_style is `true`."
        },
        {
            in: "query",
            name: "useSubCh",
            type: "boolean",
            allowEmptyValue: true,
            default: true,
            description: "Specify true to specify the channel in the subchannel style. Only used for BS scans. (e.g. BS01_0)"
        },
        {
            in: "query",
            name: "registerMode",
            type: "string",
            enum: [RegisterMode.Channel, RegisterMode.Service],
            description: "When you register the scanned channel information, specify whether you want to register it by channel or by service. \n\
            Default: GR(Channel), BS/CS(Service)"
        },
        {
            in: "query",
            name: "registerOnDisabled",
            type: "boolean",
            allowEmptyValue: true,
            description: "Specify `true` to disable the channel setting during registration.\n\
            Default: GR(false), BS/CS(true)"
        }
    ],
    responses: {
        200: {
            description: "OK"
        },
        409: {
            description: "Already Scanning",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
