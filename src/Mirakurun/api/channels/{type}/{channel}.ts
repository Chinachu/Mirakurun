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

import { Operation } from 'express-openapi';
import * as api from '../../../api';
import Channel from '../../../Channel';

export const parameters = [
    {
        in: 'path',
        name: 'type',
        type: 'string',
        enum: ['GR', 'BS', 'CS', 'SKY'],
        required: true
    },
    {
        in: 'path',
        name: 'channel',
        type: 'string',
        required: true
    }
];

export const get: Operation = (req, res) => {

    const channel = Channel.get(req.params.type, req.params.channel);

    if (channel === null) {
        api.responseError(res, 404);
        return;
    }

    const body: any = channel.export();

    body.services = channel.getServices().map(service => ({
        id: service.id,
        serviceId: service.serviceId,
        networkId: service.networkId,
        name: service.name
    }));

    res.json(body);
};

get.apiDoc = {
    tags: ['channels'],
    operationId: 'getChannel',
    responses: {
        200: {
            description: 'OK',
            schema: {
                $ref: '#/definitions/Channel'
            }
        },
        404: {
            description: 'Not Found',
            schema: {
                $ref: '#/definitions/Error'
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