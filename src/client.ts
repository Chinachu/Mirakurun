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
"use strict";

import * as fs from "fs";
import * as http from "http";
import * as querystring from "querystring";
import * as yaml from "js-yaml";
import * as apid from "../api";
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

export interface ChannelScanOption {
    type?: apid.ChannelType;
    min?: number;
    max?: number;
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
            method: method,
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
            opt.path += "?" + querystring.stringify(option.query);
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

    private async _requestStream(method: RequestMethod, path: string, option: RequestOption = {}): Promise<http.IncomingMessage> {

        const res = await this._httpRequest(method, path, option);

        if (res.statusCode >= 200 && res.statusCode <= 202) {
            return res;
        } else {
            throw res;
        }
    }

    private async _getTS(path: string, decode = true): Promise<http.IncomingMessage> {

        const option: RequestOption = {
            query: {
                decode: decode ? "1" : "0"
            }
        };

        const res = await this._requestStream("GET", path, option);

        if (res.headers["content-type"] === "video/MP2T") {
            return res;
        } else {
            throw res;
        }
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

                    res.on("data", chunk => chunks.push(<Buffer>chunk));
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

    async getChannels(query?: ChannelsQuery): Promise<apid.Channel[]> {

        const res = await this.request("GET", "/channels", { query: query });
        return res.body as apid.Channel[];
    }

    async getChannelsByType(type: apid.ChannelType, query?: ChannelsQuery): Promise<apid.Channel[]> {

        const res = await this.request("GET", `/channels/${type}`, { query: query });
        return res.body as apid.Channel[];
    }

    async getChannel(type: apid.ChannelType, channel: string): Promise<apid.Channel> {

        const res = await this.request("GET", `/channels/${type}/${channel}`);
        return res.body as apid.Channel;
    }

    async getServicesByChannel(type: apid.ChannelType, channel: string): Promise<apid.Service[]> {

        const res = await this.request("GET", `/channels/${type}/${channel}/services`);
        return res.body as apid.Service[];
    }

    async getServiceByChannel(type: apid.ChannelType, channel: string, sid: apid.ServiceId): Promise<apid.Service> {

        const res = await this.request("GET", `/channels/${type}/${channel}/services/${sid}`);
        return res.body as apid.Service;
    }

    async getServiceStreamByChannel(type: apid.ChannelType, channel: string, sid: apid.ServiceId, decode?: boolean): Promise<http.IncomingMessage> {

        return await this._getTS(`/channels/${type}/${channel}/services/${sid}/stream`, decode);
    }

    async getChannelStream(type: apid.ChannelType, channel: string, decode?: boolean): Promise<http.IncomingMessage> {

        return await this._getTS(`/channels/${type}/${channel}/stream`, decode);
    }

    async getPrograms(query?: ProgramsQuery): Promise<apid.Program[]> {

        const res = await this.request("GET", "/programs", { query: query });
        return res.body as apid.Program[];
    }

    async getProgram(id: apid.ProgramId): Promise<apid.Program> {

        const res = await this.request("GET", `/programs/${id}`);
        return res.body as apid.Program;
    }

    async getProgramStream(id: apid.ProgramId, decode?: boolean): Promise<http.IncomingMessage> {

        return await this._getTS(`/programs/${id}/stream`, decode);
    }

    async getServices(query?: ServicesQuery): Promise<apid.Service[]> {

        const res = await this.request("GET", "/services", { query: query });
        return res.body as apid.Service[];
    }

    async getService(id: apid.ServiceItemId): Promise<apid.Service> {

        const res = await this.request("GET", `/services/${id}`);
        return res.body as apid.Service;
    }

    async getLogoImage(id: apid.ServiceItemId): Promise<Buffer> {

        const res = await this.request("GET", `/services/${id}/logo`);
        return res.body as Buffer;
    }

    async getServiceStream(id: apid.ServiceItemId, decode?: boolean): Promise<http.IncomingMessage> {

        return await this._getTS(`/services/${id}/stream`, decode);
    }

    async getTuners(): Promise<apid.TunerDevice[]> {

        const res = await this.request("GET", "/tuners");
        return res.body as apid.TunerDevice[];
    }

    async getTuner(index: number): Promise<apid.TunerDevice> {

        const res = await this.request("GET", `/tuners/${index}`);
        return res.body as apid.TunerDevice;
    }

    async getTunerProcess(index: number): Promise<apid.TunerProcess> {

        const res = await this.request("GET", `/tuners/${index}/process`);
        return res.body as apid.TunerProcess;
    }

    async killTunerProcess(index: number): Promise<apid.TunerProcess> {

        const res = await this.request("DELETE", `/tuners/${index}/process`);
        return res.body as apid.TunerProcess;
    }

    async getEvents(): Promise<apid.Event[]> {

        const res = await this.request("GET", "/events");
        return res.body as apid.Event[];
    }

    async getEventsStream(query?: EventsQuery): Promise<http.IncomingMessage> {

        return await this._requestStream("GET", "/events/stream", { query: query });
    }

    async getChannelsConfig(): Promise<apid.ConfigChannels> {

        const res = await this.request("GET", "/config/channels");
        return res.body as apid.ConfigChannels;
    }

    async updateChannelsConfig(channels: apid.ConfigChannels): Promise<apid.ConfigChannels> {

        const res = await this.request("PUT", "/config/channels", { body: channels });
        return res.body as apid.ConfigChannels;
    }

    async channelScan(option?: ChannelScanOption): Promise<http.IncomingMessage> {

        return await this._requestStream("PUT", "/config/channels/scan", {
            query: option
        });
    }

    async getServerConfig(): Promise<apid.ConfigServer> {

        const res = await this.request("GET", "/config/server");
        return res.body as apid.ConfigServer;
    }

    async updateServerConfig(server: apid.ConfigServer): Promise<apid.ConfigServer> {

        const res = await this.request("PUT", "/config/server", { body: server });
        return res.body as apid.ConfigServer;
    }

    async getTunersConfig(): Promise<apid.ConfigTuners> {

        const res = await this.request("GET", "/config/tuners");
        return res.body as apid.ConfigTuners;
    }

    async updateTunersConfig(tuners: apid.ConfigTuners): Promise<apid.ConfigTuners> {

        const res = await this.request("PUT", "/config/tuners", { body: tuners });
        return res.body as apid.ConfigTuners;
    }

    async getLog(): Promise<string> {

        const res = await this.request("GET", "/log");
        return res.body as string;
    }

    async getLogStream(): Promise<http.IncomingMessage> {

        return await this._requestStream("GET", "/log/stream");
    }

    async checkVersion(): Promise<apid.Version> {

        const res = await this.request("GET", "/version");
        return res.body as apid.Version;
    }

    async updateVersion(force?: boolean): Promise<http.IncomingMessage> {

        return await this._requestStream("PUT", "/version/update", { query: { force: force } });
    }

    async getStatus(): Promise<apid.Status> {

        const res = await this.request("GET", "/status");
        return res.body as apid.Status;
    }

    async restart(): Promise<{}> {

        const res = await this.request("PUT", "/restart");
        return res.body;
    }
}