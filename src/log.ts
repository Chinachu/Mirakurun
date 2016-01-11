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
/// <reference path="../typings/tsd.d.ts" />
'use strict';

import util = require('util');

export enum LogLevel {
    'FATAL' = -1,
    'ERROR' = 0,
    'WARN' = 1,
    'INFO' = 2,
    'DEBUG' = 3
}

export var logLevel: LogLevel = LogLevel.INFO;

function getLogString(lvstr: string, msgs: string[]) {
    return new Date().toISOString() + ' ' + lvstr + ': ' + util.format.apply(null, msgs);
};

export function debug(...msgs: string[]);
export function debug(): void {
    if (logLevel >= LogLevel.DEBUG) {
        console.debug(getLogString.call(this, 'debug', arguments));
    }
};

export function info(...msgs: string[]);
export function info(): void {
    if (logLevel >= LogLevel.DEBUG) {
        console.info(getLogString.call(this, 'info', arguments));
    }
};

export function warn(...msgs: string[]);
export function warn(): void {
    if (logLevel >= LogLevel.DEBUG) {
        console.warn(getLogString.call(this, 'warn', arguments));
    }
};

export function error(...msgs: string[]);
export function error(): void {
    if (logLevel >= LogLevel.DEBUG) {
        console.error(getLogString.call(this, 'error', arguments));
    }
};

export function fatal(...msgs: string[]);
export function fatal(): void {
    if (logLevel >= LogLevel.DEBUG) {
        console.error(getLogString.call(this, 'fatal', arguments));
    }
};