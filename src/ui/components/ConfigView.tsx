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
    Nav
} from "@fluentui/react";
import { UIState } from "../index";
import ServerConfigurator from "./ServerConfigurator";
import TunersConfigurator from "./TunersConfigurator";
import ChannelsConfigurator from "./ChannelsConfigurator";

const ConfigView: React.FC<{ uiState: UIState, uiStateEvents: EventEmitter }> = ({ uiState, uiStateEvents }) => {

    const [key, setKey] = useState<string>("server");

    return (
        <Stack horizontal tokens={{ childrenGap: "0 8" }} style={{ margin: "8px 0" }}>
            <Nav
                groups={[
                    {
                        links: [
                            {
                                key: "server",
                                name: "Server",
                                url: null,
                                onClick: () => setKey("server")
                            },
                            {
                                key: "tuners",
                                name: "Tuners",
                                url: null,
                                onClick: () => setKey("tuners")
                            },
                            {
                                key: "channels",
                                name: "Channels",
                                url: null,
                                onClick: () => setKey("channels")
                            }
                        ]
                    }
                ]}
                selectedKey={key}
                styles={{ root: { width: 150 } }}
            />
            <Stack.Item grow>
                <div style={{ margin: "8px 0 8px 24px" }}>
                    {key === "server" && <ServerConfigurator uiState={uiState} uiStateEvents={uiStateEvents} />}
                    {key === "tuners" && <TunersConfigurator uiState={uiState} uiStateEvents={uiStateEvents} />}
                    {key === "channels" && <ChannelsConfigurator uiState={uiState} uiStateEvents={uiStateEvents} />}
                </div>
            </Stack.Item>
        </Stack>
    );
};

export default ConfigView;
