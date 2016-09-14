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
/// <reference path="../typings/globals/node/index.d.ts" />
/// <reference path="../typings/globals/js-yaml/index.d.ts" />
"use strict";

import * as fs from "fs";
import * as http from "http";
import * as querystring from "querystring";
import * as yaml from "js-yaml";
import * as apid from "../api.d.ts";
const pkg = require("../package.json");
const spec = yaml.safeLoad(fs.readFileSync(__dirname + "/../api.yml", "utf8"));

export type RequestMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOption {
    /** positive integer */
    priority?: number;
    /** request headers */
    headers?: { [key: string]: string };
    /** request query */
    query?: { [key: string]: any };
    /** request body */
    body?: string | Object;
}

export interface Response {
    status: number;
    statusText: string;
    contentType: string;
    headers: { [key: string]: string };
    isSuccess: boolean;
    body?: Object | Buffer;
}

export interface ErrorResponse extends Response {
    body?: apid.Error;
}

export interface ChannelsQuery {
    type?: apid.ChannelType;
    channel?: string;
    name?: string;
}

export interface ProgramsQuery {
    networkId?: apid.NetworkId;
    serviceId?: apid.ServiceId;
    eventId?: apid.EventId;
}

export interface EventsQuery {
    resource?: apid.EventResource;
    type?: apid.EventType;
}

export interface ServicesQuery {
    serviceId?: apid.ServiceId;
    networkId?: apid.NetworkId;
    name?: string;
    type?: number;
    "channel.type"?: apid.ChannelType;
    "channel.channel"?: string;
}

export default class Client {

    basePath = spec.basePath as string;
    /** positive integer */
    priority = 0;
    host = "";
    port = 40772;
    socketPath = process.platform === "win32" ? "\\\\.\\pipe\\mirakurun" : "/var/run/mirakurun.sock";
    agent: http.Agent | boolean;
    /** provide User-Agent string to identify client. */
    userAgent = "";

    private _userAgent = `MirakurunClient/${pkg.version} Node/${process.version} (${process.platform})`;

    constructor() {
    }

    private _httpRequest(method: RequestMethod, path: string, option: RequestOption = {}): Promise<http.IncomingMessage> {

        const opt: http.RequestOptions = {
            path: this.basePath + path,
            headers: option.headers || {},
            agent: this.agent
        };

        if (this.host === "") {
            opt.socketPath = this.socketPath;
        } else {
            opt.host = this.host;
            opt.port = this.port;
        }

        if (this.userAgent === "") {
            opt.headers["User-Agent"] = this._userAgent;
        } else {
            opt.headers["User-Agent"] = this.userAgent + " " + this._userAgent;
        }

        if (option.priority === undefined) {
            option.priority = this.priority;
        }
        opt.headers["X-Mirakurun-Priority"] = option.priority.toString(10);

        if (typeof option.query === "object") {
            path += "?" + querystring.stringify(option.query);
        }

        if (typeof option.body === "object") {
            opt.headers["Content-Type"] = "application/json; charset=utf-8";
            option.body = JSON.stringify(option.body);
        }

        return new Promise((resolve, reject) => {

            const req = http.request(opt, res => {

                if (res.statusCode > 300 && res.statusCode < 400 && res.headers["location"]) {
                    if (/^\//.test(res.headers["location"]) === false) {
                        reject(new Error(`Error: Redirecting location "${res.headers["location"]}" isn't supported.`));
                        return;
                    }
                    this._httpRequest(method, res.headers["location"], option)
                        .then(resolve, reject);
                    return;
                }

                resolve(res);
            });

            req.on("error", reject);

            // write request body
            if (typeof option.body === "string") {
                req.write(option.body + "\n");
            }
            req.end();
        });
    }

    private _requestStream(method: RequestMethod, path: string, option: RequestOption = {}): Promise<http.IncomingMessage> {

        return new Promise((resolve, reject) => {

            this._httpRequest(method, path, option).then(
                res => {

                    if (res.statusCode >= 200 && res.statusCode <= 202) {
                        resolve(res);
                    } else {
                        reject(res);
                    }
                },
                err => reject(err)
            );
        });
    }

    private _getTS(path: string, decode = true): Promise<http.IncomingMessage> {

        const option: RequestOption = {
            query: {
                decode: decode ? "1" : "0"
            }
        };

        return new Promise((resolve, reject) => {

            this._requestStream("GET", path, option).then(
                res => {

                    if (res.headers["content-type"] === "video/MP2T") {
                        resolve(res);
                    } else {
                        reject(res);
                    }
                },
                err => reject(err)
            );
        });
    }

    request(method: RequestMethod, path: string, option: RequestOption = {}): Promise<Response>|Promise<ErrorResponse> {

        return new Promise((resolve, reject) => {

            this._httpRequest(method, path, option).then(
                res => {

                    const ret: Response = {
                        status: res.statusCode,
                        statusText: res.statusMessage,
                        contentType: res.headers["content-type"].split(";")[0],
                        headers: res.headers,
                        isSuccess: (res.statusCode >= 200 && res.statusCode <= 202)
                    };

                    const chunks: Buffer[] = [];

                    res.on("data", chunk => chunks.push(chunk));
                    res.on("end", () => {

                        const buffer = Buffer.concat(chunks);

                        if (ret.contentType === "application/json") {
                            ret.body = JSON.parse(buffer.toString("utf8"));
                        } else {
                            ret.body = buffer;
                        }

                        if (ret.isSuccess === true) {
                            resolve(ret);
                        } else {
                            reject(ret);
                        }
                    });
                },
                err => {

                    const ret: Response = {
                        status: -1,
                        statusText: "Request Failure",
                        contentType: "",
                        headers: {},
                        isSuccess: false,
                        body: err
                    };

                    reject(ret);
                }
            );
        });
    }

    getChannels(query?: ChannelsQuery): Promise<apid.Channel[]> {

        return this.request("GET", "/channels", { query: query })
                   .then(res => Promise.resolve(res.body));
    }

    getChannelsByType(type: apid.ChannelType, query?: ChannelsQuery): Promise<apid.Channel[]> {

        return this.request("GET", `/channels/${type}`, { query: query })
                   .then(res => Promise.resolve(res.body));
    }

    getChannel(type: apid.ChannelType, channel: string): Promise<apid.Channel> {

        return this.request("GET", `/channels/${type}/${channel}`)
                   .then(res => Promise.resolve(res.body));
    }

    getServicesByChannel(type: apid.ChannelType, channel: string): Promise<apid.Service[]> {

        return this.request("GET", `/channels/${type}/${channel}/services`)
                   .then(res => Promise.resolve(res.body));
    }

    getServiceByChannel(type: apid.ChannelType, channel: string, sid: apid.ServiceId): Promise<apid.Service> {

        return this.request("GET", `/channels/${type}/${channel}/services/${sid}`)
                   .then(res => Promise.resolve(res.body));
    }

    getServiceStreamByChannel(type: apid.ChannelType, channel: string, sid: apid.ServiceId, decode?: boolean): Promise<http.IncomingMessage> {

        return this._getTS(`/channels/${type}/${channel}/services/${sid}/stream`, decode)
                   .then(res => Promise.resolve(res));
    }

    getChannelStream(type: apid.ChannelType, channel: string, decode?: boolean): Promise<http.IncomingMessage> {

        return this._getTS(`/channels/${type}/${channel}/stream`, decode)
                   .then(res => Promise.resolve(res));
    }

    getPrograms(query?: ProgramsQuery): Promise<apid.Program[]> {

        return this.request("GET", "/programs", { query: query })
                   .then(res => Promise.resolve(res.body));
    }

    getProgram(id: apid.ProgramId): Promise<apid.Program> {

        return this.request("GET", `/programs/${id}`)
                   .then(res => Promise.resolve(res.body));
    }

    getProgramStream(id: apid.ProgramId, decode?: boolean): Promise<http.IncomingMessage> {

        return this._getTS(`/programs/${id}/stream`, decode)
                   .then(res => Promise.resolve(res));
    }

    getServices(query?: ServicesQuery): Promise<apid.Service[]> {

        return this.request("GET", "/services", { query: query })
                   .then(res => Promise.resolve(res.body));
    }

    getService(id: apid.ServiceItemId): Promise<apid.Service> {

        return this.request("GET", `/services/${id}`)
                   .then(res => Promise.resolve(res.body));
    }

    getLogoImage(id: apid.ServiceItemId): Promise<Buffer> {

        return this.request("GET", `/services/${id}/logo`)
                   .then(res => Promise.resolve(res.body));
    }

    getServiceStream(id: apid.ServiceItemId, decode?: boolean): Promise<http.IncomingMessage> {

        return this._getTS(`/services/${id}/stream`, decode)
                   .then(res => Promise.resolve(res));
    }

    getTuners(): Promise<apid.TunerDevice[]> {

        return this.request("GET", "/tuners")
                   .then(res => Promise.resolve(res.body));
    }

    getTuner(index: number): Promise<apid.TunerDevice> {

        return this.request("GET", `/tuners/${index}`)
                   .then(res => Promise.resolve(res.body));
    }

    getTunerProcess(index: number): Promise<apid.TunerProcess> {

        return this.request("GET", `/tuners/${index}/process`)
                   .then(res => Promise.resolve(res.body));
    }

    killTunerProcess(index: number): Promise<apid.TunerProcess> {

        return this.request("DELETE", `/tuners/${index}/process`)
                   .then(res => Promise.resolve(res.body));
    }

    getEvents(): Promise<apid.Event[]> {

        return this.request("GET", "/events")
                   .then(res => Promise.resolve(res.body));
    }

    getEventsStream(query?: EventsQuery): Promise<http.IncomingMessage> {

        return this._requestStream("GET", "/events/stream", { query: query })
                   .then(res => Promise.resolve(res));
    }

    getChannelsConfig(): Promise<apid.ConfigChannels> {

        return this.request("GET", "/config/channels")
                   .then(res => Promise.resolve(res.body));
    }

    updateChannelsConfig(channels: apid.ConfigChannels): Promise<apid.ConfigChannels> {

        return this.request("PUT", "/config/channels", { body: channels })
                   .then(res => Promise.resolve(res.body));
    }

    getServerConfig(): Promise<apid.ConfigServer> {

        return this.request("GET", "/config/server")
                   .then(res => Promise.resolve(res.body));
    }

    updateServerConfig(server: apid.ConfigServer): Promise<apid.ConfigServer> {

        return this.request("PUT", "/config/server", { body: server })
                   .then(res => Promise.resolve(res.body));
    }

    getTunersConfig(): Promise<apid.ConfigTuners> {

        return this.request("GET", "/config/tuners")
                   .then(res => Promise.resolve(res.body));
    }

    updateTunersConfig(tuners: apid.ConfigTuners): Promise<apid.ConfigTuners> {

        return this.request("PUT", "/config/tuners", { body: tuners })
                   .then(res => Promise.resolve(res.body));
    }

    getLog(): Promise<string> {

        return this.request("GET", "/log")
                   .then(res => Promise.resolve(res.body));
    }

    getLogStream(): Promise<http.IncomingMessage> {

        return this._requestStream("GET", "/log/stream")
                   .then(res => Promise.resolve(res));
    }

    checkVersion(): Promise<apid.Version> {

        return this.request("GET", "/version")
                   .then(res => Promise.resolve(res.body));
    }

    updateVersion(force?: boolean): Promise<http.IncomingMessage> {

        return this._requestStream("PUT", "/log/stream", { query: { force: force } })
                   .then(res => Promise.resolve(res));
    }

    getStatus(): Promise<apid.Status> {

        return this.request("GET", "/status")
                   .then(res => Promise.resolve(res.body));
    }
}