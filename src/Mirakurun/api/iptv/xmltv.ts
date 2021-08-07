/*
   Copyright 2021 kanreisa

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
import Service from "../../Service";
import Program from "../../Program";

function escapeXMLSpecialChars(str: string): string {
    return str.replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function getDateTime(time: number): string {
    return new Date(time).toISOString()
        .replace(/\..+$/, "")
        .replace(/[-:T]/g, "");
}

export const get: Operation = async (req, res) => {

    const apiRoot = `${req.protocol}://${req.headers.host}/api`;

    const services = [...Service.all()]; // shallow copy
    services.sort((a, b) => a.getOrder() - b.getOrder());

    let x = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    x += `<!DOCTYPE tv SYSTEM "xmltv.dtd">\n`;
    x += `<tv source-info-name="Mirakurun">\n`;

    const countMap = new Map<number, number>();
    for (const service of services) {
        if (service.type !== 1) {
            continue;
        }

        const mainNum = service.remoteControlKeyId || service.serviceId;
        if (countMap.has(mainNum)) {
            countMap.set(mainNum, countMap.get(mainNum) + 1);
        } else {
            countMap.set(mainNum, 1);
        }
        const subNum = countMap.get(mainNum);

        x += `<channel id="${service.id}">\n`;
        x += `<display-name>${escapeXMLSpecialChars(service.name)}</display-name>\n`;
        x += `<display-name>${mainNum}.${subNum}</display-name>\n`;
        if (await Service.isLogoDataExists(service.networkId, service.logoId)) {
            x += `<icon src="${apiRoot}/services/${service.id}/logo" />`;
        }
        x += `</channel>\n`;
    }

    for (const program of Program.all()) {
        const service = Service.get(program.networkId, program.serviceId);
        if (service === null) {
            continue;
        }
        x += `<programme start="${getDateTime(program.startAt)}" stop="${getDateTime(program.startAt + program.duration)}" channel="${service.id}">\n`;
        x += `<title>${escapeXMLSpecialChars(program.name || "")}</title>\n`;
        x += `<desc>${escapeXMLSpecialChars(program.description || "")}</desc>\n`;
        x += `</programme>\n`;
    }

    x += `</tv>`;

    res.setHeader("Content-Type", "text/xml; charset=utf-8");
    res.status(200);
    res.end(x);
};

get.apiDoc = {
    tags: ["iptv"],
    summary: "IPTV - XMLTV EPG Data",
    produces: ["text/xml"],
    responses: {
        200: {
            description: "OK"
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
