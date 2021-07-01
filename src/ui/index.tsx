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
import { useState, useEffect } from "react";
import * as ReactDOM from "react-dom";
import {
    createTheme,
    loadTheme,
    Fabric,
    Stack,
    ActionButton,
    Pivot,
    PivotItem,
    Separator,
    Text,
    Link,
    Icon,
    ColorClassNames
} from "@fluentui/react";
import * as _http from "http";
const http = require("stream-http") as typeof _http;
import { TunerDevice, Status, Event } from "../../api";
import UpdateAlert from "./components/UpdateAlert";
import Restart from "./components/Restart";
import StatusView from "./components/StatusView";
import EventsView from "./components/EventsView";
import LogsView from "./components/LogsView";
import ConfigView from "./components/ConfigView";
import HeartView from "./components/HeartView";
import "./index.css";

export interface UIState {
    version: string;
    statusName: string;
    statusIconName: string;
    tuners: TunerDevice[];
    status: Status;
}

const uiState: UIState = {
    version: "..",
    statusName: "Loading",
    statusIconName: "offline",
    tuners: [],
    status: null
};

const uiStateEvents = new EventEmitter();

const iconSrcMap = {
    normal: "icon.svg",
    offline: "icon-gray.svg",
    active: "icon-active.svg"
};

let reconnectTimer: any;
let statusRefreshInterval: any;
let eventsStreamReq: _http.ClientRequest;
let logStreamReq: _http.ClientRequest;

function idleStatusChecker(): boolean {

    console.log("idleStatusChecker()", "...");

    let statusName = "Standby";
    let statusIconName = "normal";

    const isActive = uiState.tuners.some(tuner => tuner.isUsing === true && tuner.users.some(user => user.priority !== -1));
    if (isActive) {
        statusName = "Active";
        statusIconName = "active";
    }

    if (uiState.statusName === statusName) {
        return false;
    }

    uiState.statusName = statusName;
    uiState.statusIconName = statusIconName;
    uiStateEvents.emit("update");

    console.log("idleStatusChecker()", "done.");
    return true;
}
uiStateEvents.on("update:tuners", idleStatusChecker);

async function connect() {

    console.log("connect()", "...");

    if (uiState.statusName === "Connecting") {
        return;
    }
    uiState.statusName = "Connecting";
    uiStateEvents.emit("update");

    window.onunhandledrejection = (event: PromiseRejectionEvent) => {
        console.warn(`UNHANDLED PROMISE REJECTION: ${event.reason}`);
        reconnect();
    };

    statusRefreshInterval = setInterval(async () => {
        if (document.hidden) {
            return;
        }
        uiState.status = await (await fetch("/api/status")).json();
        uiStateEvents.emit("update:status");
    }, 1000 * 10);

    try {
        uiState.status = await (await fetch("/api/status")).json();
        uiState.tuners = await (await fetch("/api/tuners")).json();
        eventsStreamReq = http.get("/api/events/stream", res => {
            console.log("eventsStreamReq", "statusCode", res.statusCode);
            if (res.statusCode !== 200) {
                reconnect();
                return;
            }
            res.setEncoding("utf8");
            let bufStr = "";
            res.on("data", data => {
                bufStr += data;
                let re = /\n,/mg;
                re.exec(bufStr);
                if (re.lastIndex === 0) {
                    return;
                }
                const events: Event[] = [];
                while (re.lastIndex !== 0) {
                    events.push(...JSON.parse("[" + bufStr.substr(0, re.lastIndex - 2).replace(/^\[?\n/, "") + "]"));
                    bufStr = bufStr.substr(re.lastIndex);
                    re = /\n,/mg;
                    re.exec(bufStr);
                }
                let tunerUpdated = false;
                for (const event of events) {
                    if (event.resource === "tuner" && event.type === "update") {
                        const tuner: TunerDevice = event.data;
                        uiState.tuners[tuner.index] = tuner;
                        tunerUpdated = true;
                    }
                }
                if (tunerUpdated) {
                    uiStateEvents.emit("update:tuners");
                }
                uiStateEvents.emit("data:events", events);
            });
            res.on("error", () => {
                console.log("eventsStreamReq", "error.");
                reconnect();
            });
            res.on("end", () => {
                console.log("eventsStreamReq", "end.");
                reconnect();
            });
        });
        logStreamReq = http.get("/api/log/stream", res => {
            console.log("logStreamReq", "statusCode", res.statusCode);
            if (res.statusCode !== 200) {
                reconnect();
                return;
            }
            res.setEncoding("utf8");
            let bufStr = "";
            res.on("data", data => {
                bufStr += data;
                let re = /\n/mg;
                re.exec(bufStr);
                if (re.lastIndex === 0) {
                    return;
                }
                const logs: string[] = [];
                while (re.lastIndex !== 0) {
                    logs.push(...bufStr.substr(0, re.lastIndex - 1).split("\n"));
                    bufStr = bufStr.substr(re.lastIndex);
                    re = /\n/mg;
                    re.exec(bufStr);
                }
                uiStateEvents.emit("data:logs", logs);
            });
            res.on("error", () => {
                console.log("logStreamReq", "error.");
                reconnect();
            });
            res.on("end", () => {
                console.log("logStreamReq", "end.");
                reconnect();
            });
        });
    } catch (e) {
        console.warn(e);
        reconnect();
        return;
    }

    if (uiState.version !== ".." && uiState.version !== uiState.status.version) {
        location.reload();
        return;
    }
    uiState.version = uiState.status.version;

    uiStateEvents.emit("update");
    uiStateEvents.emit("update:status");
    uiStateEvents.emit("update:tuners");

    console.log("connect()", "done.");
}

function disconnect() {

    console.log("disconnect()", "...");

    clearInterval(statusRefreshInterval);

    if (eventsStreamReq) {
        try {
            eventsStreamReq.abort();
        } catch (e) {}
    }
    if (logStreamReq) {
        try {
            logStreamReq.abort();
        } catch (e) {}
    }

    uiState.statusName = "Disconnected";
    uiState.statusIconName = "offline";
    uiStateEvents.emit("update");

    console.log("disconnect()", "done.");
}

function reconnect() {

    console.log("reconnect()", "...");

    clearTimeout(reconnectTimer);
    disconnect();
    reconnectTimer = setTimeout(connect, 5000);

    console.log("reconnect()", "done.");
}

setTimeout(connect, 0);

const Content = () => {

    const [state, setState] = useState<UIState>(uiState);

    useEffect(() => {

        const title = `${state.statusName} - Mirakurun ${state.version}`;
        if (document.title !== title) {
            document.title = title;
        }

        const icon = document.getElementById("icon");
        if (icon.getAttribute("href") !== iconSrcMap[state.statusIconName]) {
            icon.setAttribute("href", iconSrcMap[state.statusIconName]);
        }

        const onStateUpdate = () => {
            setState({ ...uiState });
        };
        uiStateEvents.on("update", onStateUpdate);

        return () => {
            uiStateEvents.removeListener("update", onStateUpdate);
        };
    });

    return (
        <Fabric style={{ margin: "16px" }}>
            <Stack tokens={{  childrenGap: "8 0" }}>
                <UpdateAlert />

                <Stack horizontal verticalAlign="center" tokens={{ childrenGap: "0 8" }}>
                    <img style={{ height: "96px" }} src={iconSrcMap[state.statusIconName]} />
                    <div className="ms-fontSize-42">Mirakurun</div>
                    <Text variant="mediumPlus" nowrap block className={ColorClassNames.themePrimary}>{state.status?.version}</Text>
                    <Text variant="medium" nowrap block className={ColorClassNames.neutralTertiaryAlt}>({state.statusName})</Text>
                    <Stack.Item grow disableShrink>&nbsp;</Stack.Item>
                    <ActionButton
                        iconProps={{ iconName: "KnowledgeArticle" }}
                        text="API Docs"
                        target="_blank"
                        href="/api/debug"
                    />
                    <Restart uiStateEvents={uiStateEvents} />
                </Stack>

                <Pivot>
                    <PivotItem itemIcon="GroupedList" headerText="Status / Tuners">
                        <StatusView uiState={uiState} uiStateEvents={uiStateEvents} />
                    </PivotItem>
                    <PivotItem itemIcon="EntitlementRedemption" headerText="Events">
                        <EventsView uiStateEvents={uiStateEvents} />
                    </PivotItem>
                    <PivotItem itemIcon="ComplianceAudit" headerText="Logs">
                        <LogsView uiStateEvents={uiStateEvents} />
                    </PivotItem>
                    <PivotItem itemIcon="Settings" headerText="Config">
                        <ConfigView uiState={uiState} uiStateEvents={uiStateEvents} />
                    </PivotItem>
                    <PivotItem itemIcon="Heart" headerText="Special Thanks">
                        <HeartView />
                    </PivotItem>
                </Pivot>

                <Stack>
                    <Separator />
                    <Text>
                        <Link href="https://github.com/Chinachu/Mirakurun" target="_blank">Mirakurun</Link> {state.version}
                        &nbsp;&copy; 2016- <Link href="https://github.com/kanreisa" target="_blank">kanreisa</Link>.
                    </Text>
                    <Text>
                        <Icon iconName="Heart" /> <Link href="https://chinachu.moe/" target="_blank">Chinachu Project</Link>
                        &nbsp;(<Link href="https://github.com/Chinachu" target="_blank">GitHub</Link>)
                    </Text>
                </Stack>

                <Stack>
                    <Text variant="xSmall" className={ColorClassNames.neutralTertiaryAlt}>
                        Mirakurun comes with ABSOLUTELY NO WARRANTY. USE AT YOUR OWN RISK.
                    </Text>
                </Stack>
            </Stack>
        </Fabric>
    );
};

ReactDOM.render(
    <Content />,
    document.getElementById("root")
);

// dark theme
const myTheme = createTheme({
    palette: {
        themePrimary: '#ffd56c',
        themeLighterAlt: '#0a0904',
        themeLighter: '#292211',
        themeLight: '#4d4020',
        themeTertiary: '#998040',
        themeSecondary: '#e0bc5e',
        themeDarkAlt: '#ffd97a',
        themeDark: '#ffdf8f',
        themeDarker: '#ffe8ac',
        neutralLighterAlt: '#2d2f37',
        neutralLighter: '#34363f',
        neutralLight: '#40424c',
        neutralQuaternaryAlt: '#474a54',
        neutralQuaternary: '#4e505b',
        neutralTertiaryAlt: '#686b77',
        neutralTertiary: '#f1f1f1',
        neutralSecondary: '#f4f4f4',
        neutralPrimaryAlt: '#f6f6f6',
        neutralPrimary: '#ebebeb',
        neutralDark: '#fafafa',
        black: '#fdfdfd',
        white: '#25272e',
    }
});
loadTheme(myTheme);
