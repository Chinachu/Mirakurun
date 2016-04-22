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
import * as config from '../../config';

export const get: Operation = (req, res) => {

    res.status(200);
    res.json(config.loadChannels());
};

get.apiDoc = {
    tags: ['config'],
    operationId: 'getChannelsConfig',
    responses: {
        200: {
            description: 'OK',
            schema: {
                $ref: '#/definitions/ConfigChannels'
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

export const put: Operation = (req, res) => {

    const channels: config.Channel[] = req.body;

    config.saveChannels(channels);

    res.status(200);
    res.json(channels);
};

put.apiDoc = {
    tags: ['config'],
    operationId: 'updateChannelsConfig',
    parameters: [
        {
            in: 'body',
            name: 'body',
            schema: {
                $ref: '#/definitions/ConfigChannels'
            }
        }
    ],
    responses: {
        200: {
            description: 'OK',
            schema: {
                $ref: '#/definitions/ConfigChannels'
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