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
import {
    Stack,
    Separator
} from "@fluentui/react";
import { UIState } from "../index";
import TunersManager from "./TunersManager";

interface StatusItem {
    label: string;
    text: string;
}

const StatusView: React.FC<{ uiState: UIState, uiStateEvents: EventEmitter }> = ({ uiState, uiStateEvents }) => {

    const [status, setStatus] = useState<UIState["status"]>(uiState.status);
    const [tuners, setTuners] = useState<UIState["tuners"]>(uiState.tuners);

    useEffect(() => {

        const onStatusUpdate = () => {
            setStatus({ ...uiState.status });
        };
        uiStateEvents.on("update:status", onStatusUpdate);

        const onTunersUpdate = () => {
            setTuners([ ...uiState.tuners ]);
        };
        uiStateEvents.on("update:tuners", onTunersUpdate);

        return () => {
            uiStateEvents.off("update:status", onStatusUpdate);
            uiStateEvents.off("update:tuners", onTunersUpdate);
        };
    }, []);

    const statusItem: StatusItem[] = [];

    if (status) {
        const dockerStat = status.process?.env?.DOCKER === "YES" ? "🐋" : "";
        statusItem.push({ label: "Platform", text: `${status.process?.platform} (${status.process?.arch}) ${dockerStat}` });
        statusItem.push({ label: "Node.js Version", text: status.process?.versions?.node });
        statusItem.push({ label: "Memory (RSS)", text: `${Math.round(status.process?.memoryUsage?.rss / 1024 / 1024)} MB` });
        statusItem.push({ label: "EPG Gathering Network IDs", text: status.epg.gatheringNetworks.map(id => `0x${id.toString(16)}`).join(", ") });
        statusItem.push({ label: "EPG Stored Events", text: `${status.epg.storedEvents} Events` });
        statusItem.push({ label: "TunerDevice Streams", text: `${status.streamCount.tunerDevice}` });
        statusItem.push({ label: "TSFilter Streams", text: `${status.streamCount.tsFilter}` });
        statusItem.push({ label: "Decoder Streams", text: `${status.streamCount.decoder}` });
    }

    const statusList: JSX.Element[] = [];
    for (let i = 0; i < statusItem.length; i++) {
        const item = statusItem[i];
        statusList.push(
            <div key={`status-list-item${i}`} className="ms-Grid-col ms-sm12 ms-xl6 ms-xxl4 ms-xxxl3">
                <div className="ms-Grid" style={{ margin: 4 }}>
                    <div className="ms-Grid-row">
                        <div className="ms-Grid-col ms-sm6"><span className="ms-fontWeight-semibold">{item.label}</span></div>
                        <div className="ms-Grid-col ms-sm6"><span>{item.text}</span></div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <Stack tokens={{ childrenGap: "8 0" }} style={{ margin: "8px 0" }}>
            <Stack>
                <Separator alignContent="start">Status</Separator>
                <div className="ms-Grid" dir="ltr">
                    <div className="ms-Grid-row">
                        {statusList}
                    </div>
                </div>
            </Stack>
            <Stack>
                <Separator alignContent="start">Tuners</Separator>
                <TunersManager tuners={tuners} />
            </Stack>
        </Stack>
    );
};

export default StatusView;
