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
/// <reference path="../../typings/node/node.d.ts" />
'use strict';

import stream = require('stream');
//import util = require('util');
import log = require('./log');

interface StreamOptions extends stream.DuplexOptions {
    serviceId?: number;
    eventId?: number;
}

class TSFilter extends stream.Duplex {

    serviceId: number;
    eventId: number;

    private allowHalfOpen: boolean = false;
    private highWaterMark: number = 1024 * 16;
    //private _buffer: Buffer = new Buffer(1024 * 1024 * 8);
    //private _buffered: number = 0;
    private _closed: boolean = false;

    constructor(options: StreamOptions) {
        super();

        this.serviceId = options.serviceId || null;
        this.eventId = options.eventId || null;

        this.once('finish', this.close.bind(this));
        this.once('close', this.close.bind(this));

        log.debug('TSFilter has created (serviceId=%s, eventId=%s)', this.serviceId, this.eventId);
        //
    }

    _read(size: number) {

        if (this._closed === true) {
            this.push(null);
            return;
        }

        /*
        if (this._buffered > 0) {
            let buf: Buffer;

            size = Math.min(this._buffered, size);

            buf = new Buffer(size);
            this._buffer.copy(buf, 0, 0, size);

            this.push(buf);

            buf = new Buffer(this._buffer.slice(size, this._buffered));

            this._buffered = buf.copy(this._buffer);
        } else {
            setTimeout(this._read.bind(this), 100, size);
        }
        */
    }

    _write(chunk: Buffer, encoding, callback: Function) {

        this.push(chunk);
        /*
        if (this._buffered + chunk.length > this._buffer.length) {
            this._buffer.copy(this._buffer, 0, chunk.length);
            this._buffered = this._buffer.length - chunk.length;
        }

        this._buffered += chunk.copy(this._buffer, this._buffered);
        */

        callback();
        //
    }

    close(): void {

        if (this._closed === true) {
            return;
        }
        this._closed = true;

        //this._buffer = null;

        this.emit('close');

        log.debug('TSFilter has closed (serviceId=%s, eventId=%s)', this.serviceId, this.eventId);
    }
}

export = TSFilter;