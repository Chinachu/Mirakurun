/// <reference path="../typings/tsd.d.ts" />
'use strict';

import util = require('util');

export interface ILogLevel {
    level: number;
    label: string;
    isStderr?: boolean;
}

export enum ELogLevel {
    'FATAL' = -1,
    'ERROR' = 0,
    'WARN' = 1,
    'INFO' = 2,
    'DEBUG' = 3
}

export var logLevel: ELogLevel = ELogLevel.INFO;

function getLogString(lvstr: string, msgs: string[]) {
    return new Date().toISOString() + ' ' + lvstr + ': ' + util.format.apply(null, msgs);
};

export function debug(...msgs: string[]);
export function debug(): void {
    if (logLevel >= ELogLevel.DEBUG) {
        console.log(getLogString.call(this, 'debug', arguments));
    }
};

export function info(...msgs: string[]);
export function info(): void {
    if (logLevel >= ELogLevel.DEBUG) {
        console.log(getLogString.call(this, 'info', arguments));
    }
};

export function warn(...msgs: string[]);
export function warn(): void {
    if (logLevel >= ELogLevel.DEBUG) {
        console.error(getLogString.call(this, 'warn', arguments));
    }
};

export function error(...msgs: string[]);
export function error(): void {
    if (logLevel >= ELogLevel.DEBUG) {
        console.error(getLogString.call(this, 'error', arguments));
    }
};

export function fatal(...msgs: string[]);
export function fatal(): void {
    if (logLevel >= ELogLevel.DEBUG) {
        console.error(getLogString.call(this, 'fatal', arguments));
    }
};