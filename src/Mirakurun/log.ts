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
import { EventEmitter } from "events";
import * as util from "util";

export enum LogLevel {
    "FATAL" = -1,
    "ERROR" = 0,
    "WARN" = 1,
    "INFO" = 2,
    "DEBUG" = 3
}

export let logLevel: LogLevel = LogLevel.INFO;
export let maxLogHistory: number = 1000;

let offsetStr: string;
let offsetMS = 0;
if (/ GMT\+\d{4} /.test(new Date().toString()) === true) {
    const date = new Date();
    offsetStr = date.toString().match(/ GMT(\+\d{4}) /)[1];
    offsetStr = offsetStr.slice(0, 3) + ":" + offsetStr.slice(3, 5);
    offsetMS = date.getTimezoneOffset() * 60 * 1000;
}

class LogEvent extends EventEmitter {
    logs: string[] = [];

    emit(ev: "data", level: LogLevel, log: string): boolean {

        this.logs.push(log);
        if (this.logs.length > maxLogHistory) {
            this.logs.shift();
        }

        switch (level) {
            case LogLevel.DEBUG:
                console.log(log);
                break;
            case LogLevel.INFO:
                console.info(log);
                break;
            case LogLevel.WARN:
                console.warn(log);
                break;
            case LogLevel.ERROR:
            case LogLevel.FATAL:
                console.error(log);
                break;
        }

        return super.emit(ev, log);
    }

    debug(...msgs: any[]): void {
        if (logLevel >= LogLevel.DEBUG) {
            this.emit("data", LogLevel.DEBUG, getLogString.call(null, "debug", arguments));
        }
    }

    info(...msgs: any[]): void {
        if (logLevel >= LogLevel.INFO) {
            this.emit("data", LogLevel.INFO, getLogString.call(null, "info", arguments));
        }
    }

    warn(...msgs: any[]): void {
        if (logLevel >= LogLevel.WARN) {
            this.emit("data", LogLevel.WARN, getLogString.call(null, "warn", arguments));
        }
    }

    error(...msgs: any[]): void {
        if (logLevel >= LogLevel.ERROR) {
            this.emit("data", LogLevel.ERROR, getLogString.call(null, "error", arguments));
        }
    }

    fatal(...msgs: any[]): void {
        if (logLevel >= LogLevel.FATAL) {
            this.emit("data", LogLevel.FATAL, getLogString.call(null, "fatal", arguments));
        }
    }

    write(line): void {
        this.emit("data", LogLevel.INFO, line.slice(0, -1));
    }
}

export const event = new LogEvent();

function getLogString(lvstr: string, msgs: any[]) {

    let isoStr: string;

    if (offsetStr) {
        isoStr = new Date(Date.now() - offsetMS).toISOString();
        isoStr = isoStr.slice(0, -1) + offsetStr;
    } else {
        isoStr = new Date().toISOString();
    }

    return isoStr + " " + lvstr + ": " + util.format.apply(null, msgs);
}

export const debug = (...msgs: any[]) => event.debug(...msgs);
export const info = (...msgs: any[]) => event.info(...msgs);
export const warn = (...msgs: any[]) => event.warn(...msgs);
export const error = (...msgs: any[]) => event.error(...msgs);
export const fatal = (...msgs: any[]) => event.fatal(...msgs);
