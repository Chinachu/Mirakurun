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
import * as api from "../../api";
import Tuner from "../../Tuner";
const pkg = require("../../../../package.json");

export const get: Operation = (req, res) => {

    const apiRoot = `${req.protocol}://${req.headers.host}/api`;

    api.responseJSON(res, {
        FriendlyName: `Mirakurun`,
        ModelNumber: `MIRAKURUN`,
        FirmwareName: `mirakurun_${process.arch}_${process.platform}`,
        FirmwareVersion: pkg.version,
        DeviceID: "_DUMMY_",
        DeviceAuth: "_DUMMY_",
        TunerCount: Tuner.all().length,
        BaseURL: `${apiRoot}`,
        LineupURL: `${apiRoot}/iptv/lineup.json`
    });
};

get.apiDoc = {
    tags: ["iptv"],
    summary: "IPTV - Media Server Support",
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
