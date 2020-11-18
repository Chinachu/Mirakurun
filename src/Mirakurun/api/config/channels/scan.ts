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

const range = (start, end) => Array.from({length: (end - start + 1)}, (v, index) => index + start);

function generateChannels(type: string, startCh?: number, endCh?: number, startSubch?: number, endSubch?: number, bsSubchStyle?: boolean): string[] {
    switch (type) {
        case common.ChannelTypes.GR:
            startCh = startCh === undefined ? 13 : startCh;
            endCh = endCh === undefined ? 62 : endCh;
            return range(startCh, endCh).map((v) => v.toString(10));
        case common.ChannelTypes.BS:
            if (bsSubchStyle) {
                startCh = startCh === undefined ? 1 : startCh;
                endCh = endCh === undefined ? 23 : endCh;
                startSubch = startSubch === undefined ? 0 : startSubch;
                endSubch = endSubch === undefined ? 2 : endSubch;

                const channels = [];
                for (const ch of range(startCh, endCh)) {
                    for (const sCh of range(startSubch, endSubch)) {
                        channels.push(`BS${("00" + ch).slice(-2)}_${sCh}`);
                    }
                }
                return channels;
            }
            startCh = startCh === undefined ? 101 : startCh;
            endCh = endCh === undefined ? 256 : endCh;
            return range(startCh, endCh).map((v) => v.toString(10));
        case common.ChannelTypes.CS:
            startCh = startCh === undefined ? 2 : startCh;
            endCh = endCh === undefined ? 24 : endCh;
            return range(startCh, endCh).map((v) => `CS${v.toString(10)}`);
    }
}

export const put: Operation = async (req, res) => {

    if (isScanning === true) {
        api.responseError(res, 409, "Already Scanning");
        return;
    }

    isScanning = true;
    const type = req.query.type as common.ChannelType;
    const min = req.query.min as any as number;
    const max = req.query.max as any as number;
    const sMin = req.query.s_min as any as number;
    const sMax = req.query.s_max as any as number;
    const bsSubchStyle = req.query.bs_subch_style as any as boolean;
    const result: config.Channel[] = config.loadChannels().filter(channel => channel.type !== type);
    let count = 0;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);
    res.write(`channel scanning... (type: "${type}")\n\n`);

    for (const channel of generateChannels(type, min, max, sMin, sMax, bsSubchStyle)) {
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

        for (const service of services) {
            let name = service.name;
            name = name.trim();

            if (name.length === 0) {
                name = `${type}${channel}:${service.serviceId}`;
            }

            const channelItem: config.Channel = {
                name: name,
                type: type,
                channel: channel,
                serviceId: service.serviceId
            };
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
- Only when scanning BS, you can specify the channel number in the subchannel style (e.g. BS01_0). To specify the channel number, use s_min and s_max in addition to min and max. \n\
- The subchannel number parameters (s_min, s_max) are used only if the type is BS and are ignored otherwise. \n\
- Subchannel style scans scan in the following range: \n\
    From `BS${min}_${s_min}` to `BS${max}_${s_max}` \n\
- In the subchannel style, min and max are zero padded to two digits. s_min and s_max are not padded. \n\
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
            name: "min",
            type: "integer",
            description: "Specifies the minimum number of channel numbers to scan."
        },
        {
            in: "query",
            name: "max",
            type: "integer",
            description: "Specifies the maximum number of channel numbers to scan."
        },
        {
            in: "query",
            name: "s_min",
            type: "integer",
            description: "Specifies the minimum number of subchannel numbers to scan. This parameter is only used if the type is `BS` and the bs_subch_style is `true`."
        },
        {
            in: "query",
            name: "s_max",
            type: "integer",
            description: "Specifies the maximum number of subchannel numbers to scan. This parameter is only used if the type is `BS` and the bs_subch_style is `true`."
        },
        {
            in: "query",
            name: "bs_subch_style",
            type: "boolean",
            allowEmptyValue: true,
            default: true,
            description: "Specify true to specify the channel in the subchannel style. (e.g. BS01_0)"
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
