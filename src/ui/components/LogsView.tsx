/*
   Copyright 2020 kanreisa

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
import EventEmitter from "eventemitter3";
import * as React from "react";
import { useState, useEffect, useRef } from "react";
import { Client as RPCClient } from "jsonrpc2-ws";
import { JoinParams } from "../../../lib/Mirakurun/rpc.d";
import "./Logs.css";

let _itemId = 0;

let logListCache: JSX.Element[] = [];

const LogsView: React.FC<{ uiStateEvents: EventEmitter, rpc: RPCClient }> = ({ uiStateEvents, rpc }) => {

    const [logList, setLogList] = useState<JSX.Element[]>([]);
    const latestRef = useRef<HTMLDivElement>(null);

    const onLogs = (lines: string[], unshift: boolean) => {
        const newList: JSX.Element[] = [];
        for (const line of lines) {
            const parsed = line.match(/^[0-9.T:+-]+ ([a-z]+): /);
            const level = parsed ? parsed[1] : "other";
            newList.push(
                <div key={`logs-list-item${_itemId}`} className={`level-${level}`}>
                    {line}
                </div>
            );
            ++_itemId;
        }
        if (unshift === true) {
            logListCache = [...newList, ...logListCache].slice(-500);
        } else {
            logListCache = [...logListCache, ...newList].slice(-500);
        }
        setLogList(logListCache);
    };

    useEffect(() => {

        const join = () => {
            rpc.call("join", { rooms: ["logs"] } as JoinParams);
        };
        rpc.on("connected", join);
        join();

        (async () => {
            const lines: string = await (await fetch("/api/log")).text();
            onLogs(lines.trim().split("\n"), true);
        })();

        uiStateEvents.on("data:logs", onLogs);

        return () => {
            rpc.off("connected", join);
            rpc.call("leave", { rooms: ["logs"] } as JoinParams);
            uiStateEvents.off("data:logs", onLogs);
            logListCache = [];
        };
    }, []);

    useEffect(() => {
        latestRef.current.scrollIntoView();
    });

    return (
        <div className="logs" style={{ margin: "8px 0" }}>
            {logList}
            <div className="latest" ref={latestRef}></div>
        </div>
    );
};

export default LogsView;
