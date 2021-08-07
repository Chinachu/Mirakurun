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

export const get: Operation = async (req, res) => {

    const apiRoot = `${req.protocol}://${req.headers.host}/api`;

    const services = [...Service.all()]; // shallow copy
    services.sort((a, b) => a.getOrder() - b.getOrder());

    let m = `#EXTM3U url-tvg="${apiRoot}/iptv/xmltv"\n`;
    for (const service of services) {
        if (service.type !== 1) {
            continue;
        }

        m += `#EXTINF:-1 tvg-id="${service.id}"`;
        if (await Service.isLogoDataExists(service.networkId, service.logoId)) {
            m += ` tvg-logo="${apiRoot}/services/${service.id}/logo"`;
        }
        m += ` group-title="${service.channel.type}",${service.name}\n`;
        m += `${apiRoot}/services/${service.id}/stream\n`;
    }

    res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
    res.status(200);
    res.end(m);
};

get.apiDoc = {
    tags: ["iptv"],
    summary: "IPTV - M3U Playlist",
    produces: ["application/x-mpegURL"],
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
