import * as React from "react";
import { useState, useEffect, useRef } from "react";
import { Client as RPCClient } from "jsonrpc2-ws";
import { JoinParams } from "../../../lib/Mirakurun/rpc.d";
import { state } from "../modules/state";

import "./LogsView.sass";

let _itemId = 0;
let logListCache: JSX.Element[] = [];

export const LogsView: React.FC = () => {
    console.debug("routes", "LogsView");

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
        const rpc = (state as any)._rpc as RPCClient;

        const join = () => {
            rpc.call("join", { rooms: ["logs"] } as JoinParams);
        };

        rpc.on("connected", join);

        // 既に接続済みなら即座に join、そうでなければ connected イベントを待つ
        if (rpc.isConnected()) {
            join();
        }

        // 初期ログを取得
        (async () => {
            const lines: string = await (await fetch("/api/log")).text();
            onLogs(lines.trim().split("\n"), true);
        })();

        // state の logs イベントをサブスクライブ
        const onLogsEvent = (lines: string[], unshift: boolean) => {
            onLogs(lines, unshift);
        };
        state.on("logs", onLogsEvent);

        return () => {
            rpc.off("connected", join);
            if (rpc.isConnected()) {
                rpc.call("leave", { rooms: ["logs"] } as JoinParams);
            }
            state.off("logs", onLogsEvent);
            logListCache = [];
        };
    }, []);

    useEffect(() => {
        latestRef.current?.scrollIntoView();
    });

    return (
        <div id="route-logs-view">
            <div className="logs">
                {logList}
                <div className="latest" ref={latestRef}></div>
            </div>
        </div>
    );
};
