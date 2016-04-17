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
    res.json(config.loadTuners());
};

get.apiDoc = {
    tags: ['config'],
    operationId: 'getTunersConfig',
    responses: {
        200: {
            description: 'OK',
            schema: {
                $ref: '#/definitions/ConfigTuners'
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

    const tuners: config.Tuner[] = req.body;

    config.saveTuners(tuners);

    res.status(200);
    res.json(tuners);
};

put.apiDoc = {
    tags: ['config'],
    operationId: 'updateTunersConfig',
    parameters: [
        {
            in: 'body',
            name: 'body',
            schema: {
                $ref: '#/definitions/ConfigTuners'
            }
        }
    ],
    responses: {
        200: {
            description: 'OK',
            schema: {
                $ref: '#/definitions/ConfigTuners'
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