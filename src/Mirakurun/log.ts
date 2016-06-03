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
/// <reference path="../../typings/index.d.ts" />
'use strict';

import * as util from 'util';

export enum LogLevel {
    'FATAL' = -1,
    'ERROR' = 0,
    'WARN' = 1,
    'INFO' = 2,
    'DEBUG' = 3
}

export let logLevel: LogLevel = LogLevel.INFO;

function getLogString(lvstr: string, msgs: any[]) {
    return new Date().toISOString() + ' ' + lvstr + ': ' + util.format.apply(null, msgs);
}

export function debug(...msgs: any[]);
export function debug(): void {
    if (logLevel >= LogLevel.DEBUG) {
        console.log(getLogString.call(this, 'debug', arguments));
    }
}

export function info(...msgs: any[]);
export function info(): void {
    if (logLevel >= LogLevel.INFO) {
        console.info(getLogString.call(this, 'info', arguments));
    }
}

export function warn(...msgs: any[]);
export function warn(): void {
    if (logLevel >= LogLevel.WARN) {
        console.warn(getLogString.call(this, 'warn', arguments));
    }
}

export function error(...msgs: any[]);
export function error(): void {
    if (logLevel >= LogLevel.ERROR) {
        console.error(getLogString.call(this, 'error', arguments));
    }
}

export function fatal(...msgs: any[]);
export function fatal(): void {
    if (logLevel >= LogLevel.FATAL) {
        console.error(getLogString.call(this, 'fatal', arguments));
    }
}