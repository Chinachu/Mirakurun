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
import {
    Stack,
    Spinner,
    SpinnerSize,
    DetailsList,
    Selection,
    SelectionMode,
    IColumn,
    Dropdown,
    PrimaryButton,
    DefaultButton,
    Toggle,
    Dialog,
    DialogType,
    DialogFooter,
    TextField,
    IconButton,
    ActionButton
} from "@fluentui/react";
import { UIState } from "../index";
import { ConfigChannels, ChannelType } from "../../../api";

const configAPI = "/api/config/channels";

interface Item {
    key: string;
    enable: JSX.Element;
    name: JSX.Element;
    type: JSX.Element;
    channel: JSX.Element;
    options: JSX.Element;
    controls: JSX.Element;
}

const columns: IColumn[] = [
    {
        key: "col-enable",
        name: "Enable",
        fieldName: "enable",
        minWidth: 44,
        maxWidth: 44
    },
    {
        key: "col-name",
        name: "Name",
        fieldName: "name",
        minWidth: 100,
        maxWidth: 100
    },
    {
        key: "col-type",
        name: "Type",
        fieldName: "type",
        minWidth: 65,
        maxWidth: 65
    },
    {
        key: "col-channel",
        name: "Channel",
        fieldName: "channel",
        minWidth: 70,
        maxWidth: 70
    },
    {
        key: "col-options",
        name: "Options",
        fieldName: "options",
        minWidth: 200,
        // maxWidth: 400
    },
    {
        key: "col-controls",
        name: "",
        fieldName: "controls",
        minWidth: 120,
        maxWidth: 120
    }
];

const dummySelection = new Selection(); // dummy

const typesIndex = ["GR", "BS", "CS", "SKY"];
function sortTypes(types: ChannelType[]): ChannelType[] {
    return types.sort((a, b) => typesIndex.indexOf(a) - typesIndex.indexOf(b));
}

const Configurator: React.FC<{ uiState: UIState, uiStateEvents: EventEmitter }> = ({ uiState, uiStateEvents }) => {

    const [current, setCurrent] = useState<ConfigChannels>(null);
    const [editing, setEditing] = useState<ConfigChannels>(null);
    const [showSaveDialog, setShowSaveDialog] = useState<boolean>(false);
    const [saved, setSaved] = useState<boolean>(false);
    const listContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (saved === true) {
            setTimeout(() => {
                uiStateEvents.emit("notify:restart-required");
            }, 500);
            return;
        }
        (async () => {
            try {
                const res = await (await fetch(configAPI)).json();
                console.log("ChannelsConfigurator", "GET", configAPI, "->", res);
                setEditing(JSON.parse(JSON.stringify(res)));
                setCurrent(JSON.parse(JSON.stringify(res)));
            } catch (e) {
                console.error(e);
            }
        })();
        return () => {
            setSaved(false);
        }
    }, [saved]);

    const items = [];
    editing?.forEach((ch, i) => {
        const item: Item = {
            key: `item${i}`,
            enable: (
                <Toggle
                    checked={!ch.isDisabled}
                    onChange={(ev, checked) => {
                        ch.isDisabled = !checked;
                        setEditing([...editing]);
                    }}
                    style={{ marginTop: 6 }}
                />
            ),
            name: (
                <TextField
                    value={ch.name}
                    onChange={(ev, newValue) => {
                        ch.name = newValue;
                        setEditing([...editing]);
                    }}
                    onBlur={() => {
                        if (ch.name === "") {
                            ch.name = `ch${i}`;
                            setEditing([...editing]);
                        }
                    }}
                />
            ),
            type: (
                <Dropdown
                    options={[
                        { key: "GR", text: "GR" },
                        { key: "BS", text: "BS" },
                        { key: "CS", text: "CS" },
                        { key: "SKY", text: "SKY" }
                    ]}
                    selectedKey={ch.type}
                    onChange={(ev, option) => {
                        ch.type = option.key as any;
                        setEditing([...editing]);
                    }}
                />
            ),
            channel: (
                <TextField
                    value={ch.channel}
                    onChange={(ev, newValue) => {
                        ch.channel = newValue;
                        setEditing([...editing]);
                    }}
                    onBlur={() => {
                        if (ch.channel === "") {
                            ch.channel = "0";
                            setEditing([...editing]);
                        }
                    }}
                />
            ),
            options: (
                <Stack tokens={{ childrenGap: "8 0" }}>
                    <Stack horizontal tokens={{ childrenGap: "0 8" }}>
                        <TextField
                            style={{ width: 55 }}
                            label="Service ID:"
                            value={`${ch.serviceId || ""}`}
                            onChange={(ev, newValue) => {
                                if (newValue === "") {
                                    delete ch.serviceId;
                                } else if (/^[0-9]+$/.test(newValue)) {
                                    const sid = parseInt(newValue, 10);
                                    if (sid <= 65535 && sid > 0) {
                                        ch.serviceId = sid;
                                    }
                                }
                                setEditing([...editing]);
                            }}
                        />
                        <TextField
                            style={{ width: 80 }}
                            label="Satelite:"
                            value={ch.satellite || ""}
                            onChange={(ev, newValue) => {
                                if (newValue === "") {
                                    delete ch.satellite;
                                } else {
                                    ch.satellite = newValue;
                                }
                                setEditing([...editing]);
                            }}
                        />
                        <TextField
                            style={{ width: 40 }}
                            label="Space:"
                            placeholder="0"
                            value={`${ch.space || ""}`}
                            onChange={(ev, newValue) => {
                                if (newValue === "") {
                                    delete ch.space;
                                } else if (/^[0-9]+$/.test(newValue)) {
                                    const space = parseInt(newValue, 10);
                                    if (space <= 65535 && space >= 0) {
                                        ch.space = space;
                                    }
                                }
                                setEditing([...editing]);
                            }}
                        />
                    </Stack>
                </Stack>
            ),
            controls: (
                <Stack horizontal horizontalAlign="end">
                    <IconButton
                        disabled={i === 0}
                        style={{ opacity: i === 0 ? 0 : 1 }}
                        title="Up"
                        iconProps={{ iconName: "Up" }}
                        onClick={() => {
                            editing.splice(i, 1);
                            editing.splice(i - 1, 0, ch);
                            setEditing([...editing]);
                        }}
                    />
                    <IconButton
                        disabled={i === editing.length - 1}
                        style={{ opacity: i === editing.length - 1 ? 0 : 1 }}
                        title="Down"
                        iconProps={{ iconName: "Down" }}
                        onClick={() => {
                            editing.splice(i, 1);
                            editing.splice(i + 1, 0, ch);
                            setEditing([...editing]);
                        }}
                    />
                    <IconButton
                        title="Controls"
                        iconProps={{ iconName: "More" }}
                        menuProps={{ items: [{
                            key: "remove",
                            text: "Remove Channel",
                            iconProps: { iconName: "Delete" },
                            onClick: () => {
                                editing.splice(i, 1);
                                setEditing([...editing]);
                            }
                        }] }}
                    />
                </Stack>
            )
        };
        //
        items.push(item);
    });

    const changed = JSON.stringify(current) !== JSON.stringify(editing);

    if (listContainerRef.current) {
        listContainerRef.current.style.maxHeight = "calc(100vh - 410px)";
    }

    return (
        <>
            {!current && <Spinner size={SpinnerSize.large} />}
            {editing &&
                <Stack tokens={{ childrenGap: "8 0" }}>
                    <Stack.Item>
                        <ActionButton
                            text="Add Channel"
                            iconProps={{ iconName: "Add" }}
                            onClick={() => {
                                const i = editing.length;
                                editing.push({
                                    name: `ch${i}`,
                                    type: "GR",
                                    channel: "0",
                                    isDisabled: true
                                });
                                setEditing([...editing]);
                            }}
                        />
                    </Stack.Item>

                    <div ref={listContainerRef} style={{ overflowY: "scroll" }}>
                        <DetailsList
                            setKey="items"
                            items={items}
                            columns={columns}
                            selection={dummySelection}
                            selectionMode={SelectionMode.none}
                        />
                    </div>

                    <Stack horizontal tokens={{ childrenGap: "0 8" }} style={{ marginTop: 16 }}>
                        <PrimaryButton text="Save" disabled={!changed} onClick={() => setShowSaveDialog(true)} />
                        <DefaultButton text="Cancel" disabled={!changed} onClick={() => setEditing(JSON.parse(JSON.stringify(current)))} />
                    </Stack>
                </Stack>
            }
            <Dialog
                hidden={!showSaveDialog}
                onDismiss={() => setShowSaveDialog(false)}
                dialogContentProps={{
                    type: DialogType.largeHeader,
                    title: "Save",
                    subText: "Restart is required to apply configuration."
                }}
            >
                <DialogFooter>
                    <PrimaryButton
                        text="Save"
                        onClick={() => {
                            setShowSaveDialog(false);
                            (async () => {
                                console.log("ChannelsConfigurator", "PUT", configAPI, "<-", editing);
                                await fetch(configAPI, {
                                    method: "PUT",
                                    headers: { "Content-Type": "application/json; charset=utf-8" },
                                    body: JSON.stringify(editing)
                                });
                                setSaved(true);
                            })();
                        }}
                    />
                    <DefaultButton
                        text="Cancel"
                        onClick={() => setShowSaveDialog(false)}
                    />
                </DialogFooter>
            </Dialog>
        </>
    );
};

export default Configurator;
