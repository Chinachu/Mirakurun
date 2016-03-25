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
/// <reference path="../../../../../../typings/express/express.d.ts" />
'use strict';

import express = require('express');
import api = require('../../../../api');
import Channel = require('../../../../Channel');

export function get(req: express.Request, res: express.Response) {

    const channel = Channel.get(req.params.type, req.params.channel);

    if (channel === null) {
        api.responseError(res, 404);
        return;
    }

    let requestAborted = false;
    req.once('close', () => requestAborted = true);

    channel.getStream({
        id: (req.ip || 'unix') + ':' + (req.connection.remotePort || Date.now()),
        priority: parseInt(req.get('X-Mirakurun-Priority') || '0', 10),
        agent: req.get('User-Agent'),
        disableDecoder: (req.query.decode === '0')
    })
        .then(stream => {

            if (requestAborted === true) {
                return stream.emit('close');
            }

            req.once('close', () => stream.emit('close'));

            res.status(200);
            stream.pipe(res);
        })
        .catch((err) => api.responseStreamErrorHandler(res, err));
}