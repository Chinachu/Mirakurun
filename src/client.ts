/*
   Copyright 2016 kanreisa

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
import * as fs from "fs";
import * as http from "http";
import * as querystring from "querystring";
import * as yaml from "js-yaml";
import { OpenAPIV2 } from "openapi-types";
import * as apid from "../api";
import { IncomingHttpHeaders } from "http";
const pkg = require("../package.json");
const spec = yaml.safeLoad(fs.readFileSync(__dirname + "/../api.yml", "utf8")) as OpenAPIV2.Document;

export type RequestMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOption {
    /** positive integer */
    priority?: number;
    /** request headers */
    headers?: { [key: string]: string };
    /** request query */
    query?: { [key: string]: any };
    /** request body */
    body?: string | object;
}

export interface Response {
    status: number;
    statusText: string;
    contentType: string;
    headers: IncomingHttpHeaders;
    isSuccess: boolean;
    body?: any | string | Buffer;
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

    basePath = spec.basePath;
    docsPath = "/docs";
    /** positive integer */
    priority = 0;
    host = "";
    port = 40772;
    socketPath = process.platform === "win32" ? "\\\\.\\pipe\\mirakurun" : "/var/run/mirakurun.sock";
    agent: http.Agent | boolean;
    /** provide User-Agent string to identify client. */
    userAgent = "";

    private _userAgent = `MirakurunClient/${pkg.version} Node/${process.version} (${process.platform})`;
    private _docs: OpenAPIV2.Document;

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

                    res.on("data", chunk => chunks.push(chunk as Buffer));
                    res.on("end", () => {

                        const buffer = Buffer.concat(chunks);

                        if (ret.contentType === "application/json") {
                            ret.body = JSON.parse(buffer.toString("utf8"));
                        } else if (ret.contentType === "text/plain") {
                            ret.body = buffer.toString("utf8");
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

    async call(operationId: string, param: { [key: string]: any } = {}): Promise<any|http.IncomingMessage> {

        if (!this._docs) {
            await this._getDocs();
        }

        let path: string;
        let method: RequestMethod;
        let parameters: OpenAPIV2.GeneralParameterObject[];
        let operation: OpenAPIV2.OperationObject;
        for (path in this._docs.paths) {
            const p = this._docs.paths[path] as OpenAPIV2.PathItemObject;
            if (p.post?.operationId === operationId) {
                method = "POST";
                parameters = [...p.parameters, ...(p.post.parameters || [])] as any;
                operation = p.post;
                break;
            }
            if (p.get?.operationId === operationId) {
                method = "GET";
                parameters = [...p.parameters, ...(p.get.parameters || [])] as any;
                operation = p.get;
                break;
            }
            if (p.put?.operationId === operationId) {
                method = "PUT";
                parameters = [...p.parameters, ...(p.put.parameters || [])] as any;
                operation = p.put;
                break;
            }
            if (p.delete?.operationId === operationId) {
                method = "DELETE";
                parameters = [...p.parameters, ...(p.delete.parameters || [])] as any;
                operation = p.delete;
                break;
            }
        }

        if (!operation) {
            throw new Error(`operationId "${operationId}" is not found.`);
        }

        const option: RequestOption = {
            headers: {},
            query: {}
        };

        for (const p of parameters) {
            if (param[p.name] === undefined || param[p.name] === null) {
                if (p.required) {
                    throw new Error(`Required parameter "${p.name}" is undefined.`);
                }
                continue;
            }
            if (p.in === "path") {
                path = path.replace(`{${p.name}}`, param[p.name]);
            } else if (p.in === "header") {
                option.headers[p.name] = param[p.name];
            } else if (p.in === "query") {
                option.query[p.name] = param[p.name];
            } else if (p.in === "body" && p.name === "body") {
                option.body = param.body;
            }
        }

        if (operation.tags.indexOf("stream") !== -1) {
            return await this._requestStream(method, path, option);
        }
        return await this.request(method, path, option);
    }

    async getChannels(query?: ChannelsQuery): Promise<apid.Channel[]> {

        const res = await this.call("getChannels", query);
        return res.body as apid.Channel[];
    }

    async getChannelsByType(type: apid.ChannelType, query?: ChannelsQuery): Promise<apid.Channel[]> {

        const res = await this.call("getChannelsByType", { type, ...query });
        return res.body as apid.Channel[];
    }

    async getChannel(type: apid.ChannelType, channel: string): Promise<apid.Channel> {

        const res = await this.call("getChannel", { type, channel });
        return res.body as apid.Channel;
    }

    async getServicesByChannel(type: apid.ChannelType, channel: string): Promise<apid.Service[]> {

        const res = await this.call("getServicesByChannel", { type, channel });
        return res.body as apid.Service[];
    }

    async getServiceByChannel(type: apid.ChannelType, channel: string, sid: apid.ServiceId): Promise<apid.Service> {

        const res = await this.call("getServiceByChannel", { type, channel, sid });
        return res.body as apid.Service;
    }

    async getServiceStreamByChannel(type: apid.ChannelType, channel: string, sid: apid.ServiceId, decode?: boolean, priority?: number): Promise<http.IncomingMessage> {

        return await this.call("getServiceStreamByChannel", { type, channel, sid, "decode": decode ? 1 : 0, "X-Mirakurun-Priority": priority });
    }

    async getChannelStream(type: apid.ChannelType, channel: string, decode?: boolean, priority?: number): Promise<http.IncomingMessage> {

        return await this.call("getChannelStream", { type, channel, "decode": decode ? 1 : 0, "X-Mirakurun-Priority": priority });
    }

    async getPrograms(query?: ProgramsQuery): Promise<apid.Program[]> {

        const res = await this.call("getPrograms", query);
        return res.body as apid.Program[];
    }

    async getProgram(id: apid.ProgramId): Promise<apid.Program> {

        const res = await this.call("getProgram", { id });
        return res.body as apid.Program;
    }

    async getProgramStream(id: apid.ProgramId, decode?: boolean, priority?: number): Promise<http.IncomingMessage> {

        return await this.call("getProgramStream", { id, "decode": decode ? 1 : 0, "X-Mirakurun-Priority": priority });
    }

    async getServices(query?: ServicesQuery): Promise<apid.Service[]> {

        const res = await this.call("getServices", query);
        return res.body as apid.Service[];
    }

    async getService(id: apid.ServiceItemId): Promise<apid.Service> {

        const res = await this.call("getService", { id });
        return res.body as apid.Service;
    }

    async getLogoImage(id: apid.ServiceItemId): Promise<Buffer> {

        const res = await this.call("getLogoImage", { id });
        return res.body as Buffer;
    }

    async getServiceStream(id: apid.ServiceItemId, decode?: boolean, priority?: number): Promise<http.IncomingMessage> {

        return await this.call("getServiceStream", { id, "decode": decode ? 1 : 0, "X-Mirakurun-Priority": priority });
    }

    async getTuners(): Promise<apid.TunerDevice[]> {

        const res = await this.call("getTuners");
        return res.body as apid.TunerDevice[];
    }

    async getTuner(index: number): Promise<apid.TunerDevice> {

        const res = await this.call("getTuner", { index });
        return res.body as apid.TunerDevice;
    }

    async getTunerProcess(index: number): Promise<apid.TunerProcess> {

        const res = await this.call("getTunerProcess", { index });
        return res.body as apid.TunerProcess;
    }

    async killTunerProcess(index: number): Promise<apid.TunerProcess> {

        const res = await this.call("killTunerProcess", { index });
        return res.body as apid.TunerProcess;
    }

    async getEvents(): Promise<apid.Event[]> {

        const res = await this.call("getEvents");
        return res.body as apid.Event[];
    }

    async getEventsStream(query?: EventsQuery): Promise<http.IncomingMessage> {

        return await this.call("getEventsStream", query);
    }

    async getChannelsConfig(): Promise<apid.ConfigChannels> {

        const res = await this.call("getChannelsConfig");
        return res.body as apid.ConfigChannels;
    }

    async updateChannelsConfig(channels: apid.ConfigChannels): Promise<apid.ConfigChannels> {

        const res = await this.call("updateChannelsConfig", { body: channels });
        return res.body as apid.ConfigChannels;
    }

    async channelScan(option?: ChannelScanOption): Promise<http.IncomingMessage> {

        return await this.call("channelScan", option);
    }

    async getServerConfig(): Promise<apid.ConfigServer> {

        const res = await this.call("getServerConfig");
        return res.body as apid.ConfigServer;
    }

    async updateServerConfig(server: apid.ConfigServer): Promise<apid.ConfigServer> {

        const res = await this.call("updateServerConfig", { body: server });
        return res.body as apid.ConfigServer;
    }

    async getTunersConfig(): Promise<apid.ConfigTuners> {

        const res = await this.call("getTunersConfig");
        return res.body as apid.ConfigTuners;
    }

    async updateTunersConfig(tuners: apid.ConfigTuners): Promise<apid.ConfigTuners> {

        const res = await this.call("updateTunersConfig", { body: tuners });
        return res.body as apid.ConfigTuners;
    }

    async getLog(): Promise<string> {

        const res = await this.call("getLog");
        return res.body as string;
    }

    async getLogStream(): Promise<http.IncomingMessage> {

        return await this.call("getLogStream");
    }

    async checkVersion(): Promise<apid.Version> {

        const res = await this.call("checkVersion");
        return res.body as apid.Version;
    }

    async updateVersion(force?: boolean): Promise<http.IncomingMessage> {

        return await this.call("updateVersion", { force });
    }

    async getStatus(): Promise<apid.Status> {

        const res = await this.call("getStatus");
        return res.body as apid.Status;
    }

    async restart(): Promise<{}> {

        const res = await this.call("restart");
        return res.body;
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

                if (res.statusCode > 300 && res.statusCode < 400 && res.headers.location) {
                    if (/^\//.test(res.headers.location) === false) {
                        reject(new Error(`Redirecting location "${res.headers.location}" isn't supported.`));
                        return;
                    }
                    this._httpRequest(method, res.headers.location, option)
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
            if (res.statusCode) {
                throw new Error(`Bad status respond (${res.statusCode} ${res.statusMessage}).`);
            }
            throw res;
        }
    }

    private async _getDocs() {

        const res = await this.request("GET", this.docsPath);
        if (res.isSuccess !== true) {
            throw new Error(`Failed to get "${this.docsPath}".`);
        }
        this._docs = res.body;
    }
}
