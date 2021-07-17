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
    setDisabledOnAdd?: boolean;
    refresh?: boolean;
}

interface ScanConfig {
    readonly channels: string[];
    readonly registerMode: RegisterMode;
    readonly setDisabledOnAdd: boolean;
}

function range(start: number, end: number): string[] {
    return Array.from({length: (end - start + 1)}, (v, index) => (index + start).toString(10));
}

export function generateScanConfig(option: ChannelScanOption): ScanConfig {

    // delete undefined from option
    Object.keys(option).forEach(key => option[key] === undefined && delete option[key]);

    if (option.type === common.ChannelTypes.GR) {
        option = Object.assign({
            startCh: 13,
            endCh: 62,
            registerMode: RegisterMode.Channel,
            setDisabledOnAdd: false
        }, option);

        return {
            channels: range(option.startCh, option.endCh).map((ch) => ch),
            registerMode: option.registerMode,
            setDisabledOnAdd: option.setDisabledOnAdd
        };
    }

    option = Object.assign({
        registerMode: RegisterMode.Service,
        setDisabledOnAdd: true
    }, option);

    if (option.type === common.ChannelTypes.BS) {
        if (option.useSubCh) {
            option = Object.assign({
                startCh: 1,
                endCh: 23,
                startSubCh: 0,
                endSubCh: 3
            }, option);

            const channels: string[] = [];
            for (const ch of range(option.startCh, option.endCh)) {
                for (const subCh of range(option.startSubCh, option.endSubCh)) {
                    channels.push(`BS${ch.toString().padStart(2, "0")}_${subCh}`);
                }
            }

            return {
                channels: channels,
                registerMode: option.registerMode,
                setDisabledOnAdd: option.setDisabledOnAdd
            };
        }

        option = Object.assign({
            startCh: 101,
            endCh: 256
        }, option);

        return {
            channels: range(option.startCh, option.endCh).map((ch) => ch),
            registerMode: option.registerMode,
            setDisabledOnAdd: option.setDisabledOnAdd
        };
    }

    if (option.type === common.ChannelTypes.CS) {
        option = Object.assign({
            startCh: 2,
            endCh: 24
        }, option);

        return {
            channels: range(option.startCh, option.endCh).map((ch) => `CS${ch}`),
            registerMode: option.registerMode,
            setDisabledOnAdd: option.setDisabledOnAdd
        };
    }
}

export function generateChannelItemForService(type: common.ChannelType, channel: string, service: db.Service, setDisabledOnAdd: boolean): config.Channel {

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
        isDisabled: setDisabledOnAdd
    };
}

export function generateChannelItemForChannel(type: common.ChannelType, channel: string, services: db.Service[], setDisabledOnAdd: boolean): config.Channel {

    const baseName = services[0].name;
    let matchIndex = baseName.length;

    for (let servicesIndex = 1; servicesIndex < services.length; servicesIndex++) {
        const service = services[servicesIndex];
        for (let nameIndex = 0; nameIndex < baseName.length && nameIndex < service.name.length; nameIndex++) {
            if (baseName[nameIndex] !== service.name[nameIndex]) {
                if (nameIndex === 0) {
                    break;
                }
                if (nameIndex < matchIndex) {
                    matchIndex = nameIndex;
                }
                break;
            }
            if (nameIndex + 1 >= service.name.length && service.name.length < matchIndex) {
                matchIndex = service.name.length;
                break;
            }
        }
    }

    let name = baseName.slice(0, matchIndex);
    name = name.trim();
    if (name.length === 0) {
        name = `${type}${channel}`;
    }

    return {
        name: name,
        type: type,
        channel: channel,
        isDisabled: setDisabledOnAdd
    };
}

export function generateChannelItems(registerMode: RegisterMode, type: common.ChannelType, channel: string, services: db.Service[], setDisabledOnAdd: boolean): config.Channel[] {

    if (registerMode === RegisterMode.Service) {
        const channelItems: config.Channel[] = [];
        for (const service of services) {
            channelItems.push(generateChannelItemForService(type, channel, service, setDisabledOnAdd));
        }
        return channelItems;
    }

    return [generateChannelItemForChannel(type, channel, services, setDisabledOnAdd)];
}

export const put: Operation = async (req, res) => {

    if (isScanning === true) {
        api.responseError(res, 409, "Already Scanning");
        return;
    }

    req.setTimeout(1000 * 60 * 3); // 3 minites

    isScanning = true;
    const type = req.query.type as common.ChannelType;
    const refresh = req.query.refresh as any as boolean;
    const oldChannelItems = config.loadChannels();
    const result: config.Channel[] = oldChannelItems.filter(channel => channel.type !== type);
    let newCount = 0;
    let takeoverCount = 0;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);
    res.write(`channel scanning... (type: "${type}")\n\n`);

    const scanConfig = generateScanConfig({
        type: type,
        startCh: req.query.minCh as any as number,
        endCh: req.query.maxCh as any as number,
        startSubCh: req.query.minSubCh as any as number,
        endSubCh: req.query.maxSubCh as any as number,
        useSubCh: req.query.useSubCh as any as boolean,
        registerMode: req.query.registerMode as any as RegisterMode,
        setDisabledOnAdd: req.query.setDisabledOnAdd as any as boolean
    });

    for (const channel of scanConfig.channels) {
        res.write(`channel: "${channel}" ...\n`);

        if (!refresh) {
            const takeoverChannelItems = oldChannelItems.filter(chItem => chItem.type === type && chItem.channel === channel && chItem.isDisabled === false);
            if (takeoverChannelItems.length > 0) {
                res.write(`-> Skip scan.\n`);
                res.write(`-> ${takeoverChannelItems.length} existing settings were found.\n`);
                for (const channelItem of takeoverChannelItems) {
                    result.push(channelItem);
                    ++takeoverCount;
                    res.write(`-> ${JSON.stringify(channelItem)}\n`);
                }
                res.write(`*Notice* The scan was skipped to carry over the existing settings.\n\n`);
                continue;
            }
        }

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

        const scannedChannelItems = generateChannelItems(scanConfig.registerMode, type, channel, services, scanConfig.setDisabledOnAdd);
        for (const scannedChannelItem of scannedChannelItems) {
            result.push(scannedChannelItem);
            ++newCount;
            res.write(`-> ${JSON.stringify(scannedChannelItem)}\n`);
        }
        res.write(`\n`);
    }

    result.sort((a, b) => {
        if (a.type === b.type) {
            return a.channel.localeCompare(b.channel, undefined, compareOptions);
        } else {
            return channelOrder[a.type] - channelOrder[b.type];
        }
    });
    config.saveChannels(result);

    res.write(`-> total ${newCount + takeoverCount} channels (of Takeover is ${takeoverCount}) found and ${result.length} channels stored.\n\n`);

    isScanning = false;

    res.write(`channel scan has completed and saved successfully.\n`);
    res.write(`**RESTART REQUIRED** to apply changes.\n`);

    res.end();
};

put.apiDoc = {
    summary: "Scan the receivable channels and rewrite the channel settings.",
    description: `Entry rewriting specifications:
- The scan is performed on a range of channels of the specified type and the entries for those channels, if any, are saved in the configuration file.
- If the channel to be scanned is described in the configuration file and is enabled, the scan will not be performed for that channel and the entries described will remain intact. If you do not want to keep the entries, use the \`refresh\` option.
- All entries outside the channel range of the specified type will be deleted.
- All entries of a type other than the specified type will remain.

About BS Subchannel Style:
- Only when scanning BS, you can specify the channel number in the subchannel style (e.g. BS01_0). To specify the channel number, use minSubCh and maxSubCh in addition to minCh and maxCh.
- The subchannel number parameters (minSubCh, maxSubCh) are used only if the type is BS and are ignored otherwise.
- Subchannel style scans scan in the following range:
    From \`BS\${minCh}_\${minSubCh}\` to \`BS\${maxCh}_\${maxSubCh}\`
- In the subchannel style, minCh and maxCh are zero padded to two digits. minSubCh and maxSubCh are not padded.
- BS "non" subchannel style scans and GR scans are basically the same. Note that if you scan the wrong channel range, the GR channel will be registered as BS and the BS channel will be registered as GR. This problem does not occur because CS scan uses a character string with \`CS\` added as a channel number prefix.`,
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
            description: "When you register the scanned channel information, specify whether you want to register it by channel or by service.\n\n" +
                "_Default value (GR)_: Channel\n" +
                "_Default value (BS/CS)_: Service"
        },
        {
            in: "query",
            name: "setDisabledOnAdd",
            type: "boolean",
            allowEmptyValue: true,
            description: "If `true`, set disable on add channel.\n\n" +
                "_Default value (GR)_: false\n" +
                "_Default value (BS/CS)_: true"
        },
        {
            in: "query",
            name: "refresh",
            type: "boolean",
            allowEmptyValue: true,
            default: false,
            description: "If `true`, update the existing settings without inheriting them.\n" +
                "However, non-scanned types of channels will always be inherited."
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
