/*
   Copyright 2021 kanreisa

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
import * as net from "net";
import * as http from "http";
import * as ip from "ip";
import RPCServer, { Socket } from "jsonrpc2-ws/lib/server";
import * as log from "./log";
import _ from "./_";
import status from "./status";
import Event from "./Event";
import { EventMessage } from "./Event";
import { event as logEvent } from "./log";
import { isPermittedHost } from "./Server";
import { getStatus } from "./api/status";
import { sleep } from "./common";

export interface JoinParams {
    rooms: string[];
}

export interface NotifyParams<T> {
    array: T[];
}

/**
 * JSON-RPC 2.0 over WebSocket API
 *
 * This function is currently being tested internally by Chinachu Project.
 * As such, the content is subject to change.
 * There is no documentation at this time.
 * If you want to connect to Mirakurun from your application, please use OpenAPI.
 *
 * @internal
 * @experimental
 */
export function createRPCServer(server: http.Server): RPCServer {

    const rpc = new RPCServer({
        pingInterval: 1000 * 30,
        wss: {
            path: "/rpc",
            perMessageDeflate: false,
            clientTracking: false,
            noServer: true
        }
    });

    server.on("upgrade", serverOnUpgrade.bind(rpc.wss));

    rpc.on("connection", rpcConnection);

    rpc.methods.set("join", onJoin);
    rpc.methods.set("leave", onLeave);
    rpc.methods.set("getStatus", getStatus);

    return rpc;
}

const _notifierListeners = new Map<Set<RPCServer>, [Function, Function]>();
export function initRPCNotifier(rpcs: Set<RPCServer>): void {

    const eventsNMDict = {
        program: new NotifyManager<EventMessage>("events:program", "events", rpcs),
        service: new NotifyManager<EventMessage>("events:service", "events", rpcs),
        tuner: new NotifyManager<EventMessage>("events:tuner", "events", rpcs)
    };
    function onEventListener(event: EventMessage) {
        eventsNMDict[event.resource].notify(event);
    }

    const logsNM = new NotifyManager<string>("logs", "logs", rpcs);
    function onLogDataListener(log: string) {
        logsNM.notify(log);
    }

    Event.onEvent(onEventListener);
    logEvent.on("data", onLogDataListener);

    _notifierListeners.set(rpcs, [
        onEventListener,
        onLogDataListener
    ]);
}

class NotifyManager<T> {
    private _items = new Set<T>();
    private _active = false;
    constructor(private _room: string, private _method: string, private _rpcs: Set<RPCServer>) {}
    async notify(item: T) {
        this._items.add(item);
        if (this._active) {
            return;
        }
        this._active = true;
        await sleep(100);
        if (status.rpcCount > 0) {
            const params: NotifyParams<T> = {
                array: [...this._items.values()]
            };
            for (const rpc of this._rpcs) {
                if (rpc.sockets.size > 0) {
                    rpc.notifyTo(this._room, this._method, params);
                }
            }
        }
        this._items.clear();
        this._active = false;
    }
}

function serverOnUpgrade(this: RPCServer["wss"], req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {

    if (!ip.isPrivate(req.socket.remoteAddress)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
    }

    if (req.headers.origin !== undefined) {
        if (!isPermittedHost(req.headers.origin, _.config.server.hostname)) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
        }
    }

    this.handleUpgrade(req, socket, head, ws => this.emit("connection", ws, req));
}

function rpcConnection(socket: Socket, req: http.IncomingMessage): void {
    // connected
    ++status.rpcCount;

    const ip = req.socket.remoteAddress;
    const ua = "" + req.headers["user-agent"];

    socket.data.set("ip", ip);
    socket.data.set("ua", ua);

    socket.ws.on("error", wsError);
    socket.on("close", socketClose);

    log.info(`${ip} - RPC #${socket.id} connected - - ${ua}`);
}

function wsError(err: Error) {
    // error
    log.error(JSON.stringify(err, null, "  "));
    console.error(err.stack);
}

function socketClose(this: Socket): void {
    // disconnected
    --status.rpcCount;

    log.info(`${this.data.get("ip")} - RPC #${this.id} closed - ${this.data.get("ua")}`);
}

function onJoin(socket: Socket, params: JoinParams) {
    for (const room of params.rooms) {
        socket.joinTo(room);
    }
}

function onLeave(socket: Socket, params: JoinParams) {
    for (const room of params.rooms) {
        socket.leaveFrom(room);
    }
}
