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
/// <reference path="../../../typings/express/express.d.ts" />
'use strict';

import {Operation} from 'express-openapi';
import Program = require('../Program');

export var get: Operation = (req, res) => {

    let programs;

    if (req.query.serviceId) {
        programs = Program.findByServiceId(req.query.serviceId);
    } else {
        programs = Program.all();
    }

    res.json(programs.map(program => program.data));
};

get.apiDoc = {
    tags: ['programs'],
    operationId: 'getPrograms',
    parameters: [
        {
            in: 'query',
            name: 'serviceId',
            type: 'number',
            required: false
        }
    ],
    responses: {
        200: {
            description: 'OK',
            schema: {
                type: 'array',
                items: {
                    $ref: '#/definitions/Program'
                }
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