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
'use strict';

import {Operation} from 'express-openapi';
import api = require('../api');
import epg = require('../epg');

export const get: Operation = (req, res) => {

    const gatheringNetworks = [];

    for (let nid in epg.status) {
        if (epg.status[nid] === true) {
            gatheringNetworks.push(parseInt(nid, 10));
        }
    }

    api.responseJSON(res, {
        epg: {
            gatheringNetworks: gatheringNetworks
        }
    });
};

get.apiDoc = {
    tags: ['status'],
    operationId: 'getStatus',
    responses: {
        200: {
            description: 'OK',
            schema: {
                $ref: '#/definitions/Status'
            }
        },
        default: {
            description: 'Unexpected Error',
            schema: {
                $ref: '#/definitions/Error'
            }
        }
    }
};