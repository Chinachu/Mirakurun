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
import * as React from "react";
import { useState, useEffect } from "react";
import {
    Text,
    Icon,
    GroupedList,
    DetailsRow,
    Selection,
    IColumn,
    IGroup,
    Dialog,
    DialogFooter,
    DialogType,
    PrimaryButton,
    DefaultButton,
    IconButton,
    ColorClassNames
} from "@fluentui/react";
import { TunerDevice } from "../../../api";

interface Item {
    _group: string;
    _kind: "device" | "user";
    key: string;
    name: string;
    command?: JSX.Element;
    controls?: JSX.Element;
    user?: JSX.Element;
    priority?: JSX.Element;
    ch?: JSX.Element;
    sid?: JSX.Element;
    ua?: JSX.Element;
}

const deviceColumns: IColumn[] = [
    {
        key: "col-command",
        name: "",
        fieldName: "command",
        minWidth: 0,
        isResizable: true,
    },
    {
        key: "col-controls",
        name: "",
        fieldName: "controls",
        minWidth: 0
    }
];

const userColumns: IColumn[] = [
    {
        key: "col-priority",
        name: "",
        fieldName: "priority",
        minWidth: 0
    },
    {
        key: "col-user",
        name: "",
        fieldName: "user",
        minWidth: 0
    },
    {
        key: "col-ch",
        name: "",
        fieldName: "ch",
        minWidth: 0
    },
    {
        key: "col-sid",
        name: "",
        fieldName: "sid",
        minWidth: 0
    },
    {
        key: "col-ua",
        name: "",
        fieldName: "ua",
        minWidth: 0
    }
];

const dummySelection = new Selection(); // dummy

const onRenderCell = (nestingDepth: number, item: Item, itemIndex: number) => {
    return <DetailsRow
        columns={item._kind === "device" ? deviceColumns : userColumns}
        groupNestingDepth={nestingDepth + (item._kind === "device" ? 0 : 1)}
        item={item}
        itemIndex={itemIndex}
        selection={dummySelection}
        selectionMode={0}
        compact
    />
};

const TunersManager: React.FC<{ tuners: TunerDevice[] }> = ({ tuners }) => {
    const [killTarget, setKillTarget] = useState<number>(null);

    const items: Item[] = [];
    for (const tuner of tuners) {
        const item: Item = {
            _group: `#${tuner.index}: ${tuner.name} (${tuner.types.join(", ")})`,
            _kind: "device",
            key: `row-device-${tuner.index}`,
            name: tuner.name,
            command: (
                <>
                    <Icon title="Command" iconName="ServerProcesses" />
                    <Text style={{ lineHeight: "30px", marginLeft: 8 }}>{tuner.command || "-"}</Text>
                    <Text
                        style={{ lineHeight: "30px", marginLeft: 8 }}
                        className={ColorClassNames.neutralTertiaryAlt}
                    >
                        {tuner.pid ? `(pid=${tuner.pid})` : ""}
                    </Text>
                </>
            )
        };
        if (tuner.command) {
            item.controls = (
                <IconButton
                    title="Controls"
                    iconProps={{ iconName: "More" }}
                    menuProps={{ items: [{
                        key: "kill",
                        text: "Kill Tuner Process...",
                        iconProps: { iconName: "Cancel" },
                        onClick: () => setKillTarget(tuner.index)
                    }] }}
                />
            );
        }
        items.push(item);

        for (const user of tuner.users) {
            items.push({
                _group: item._group,
                _kind: "user",
                key: `${item.key}-user-${user.id}`,
                name: user.id,
                user: (
                    <>
                        <Icon title="User" iconName={/Mirakurun/.test(user.id) ? "Processing" : "PlugConnected"} />
                        <Text style={{ marginLeft: 8 }}>{user.id}</Text>
                    </>
                ),
                priority: (
                    <>
                        <Icon title="Priority" iconName="SortLines" />
                        <Text style={{ marginLeft: 8 }}>{user.priority}</Text>
                    </>
                ),
                ch: (
                    <>
                        <Icon title="Channel" iconName="TVMonitor" />
                        <Text style={{ marginLeft: 8 }}>{user.streamSetting.channel.type} / {user.streamSetting.channel.channel}</Text>
                    </>
                ),
                sid: (
                    <>
                        <Icon title="Service ID" iconName="Filter" />
                        <Text style={{ marginLeft: 8 }}>{user.streamSetting.serviceId ? `SID: 0x${user.streamSetting.serviceId.toString(16).toUpperCase()} (${user.streamSetting.serviceId})` : "-"}</Text>
                    </>
                ),
                ua: (
                    <>
                        <Icon title="User-Agent" iconName="Tag" />
                        <Text style={{ marginLeft: 8 }}>{user.agent || "-"}</Text>
                    </>
                )
            });
        }
    }

    const groups: IGroup[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let group = groups.find(group => group.key === item._group);
        if (!group) {
            group = {
                key: item._group,
                name: item._group,
                startIndex: i,
                count: 0
            };
            groups.push(group);
        }
        group.count++;
    }

    return (
        <>
            <GroupedList
                items={items}
                groups={groups}
                groupProps={{ headerProps: { styles: { headerCount: { display: "none" } } } }} // hide count
                onRenderCell={onRenderCell}
                selectionMode={0}
                compact
            />
            <Dialog
                hidden={killTarget === null}
                onDismiss={() => setKillTarget(null)}
                dialogContentProps={{
                    type: DialogType.largeHeader,
                    title: "Kill Tuner Process",
                    subText: "Do you want to kill this running tuner process?"
                }}
            >
                <DialogFooter>
                    <PrimaryButton
                        text="Kill"
                        onClick={() => {
                            (async () => {
                                await fetch(`/api/tuners/${killTarget}/process`, { method: "DELETE" });
                            })();
                            setKillTarget(null);
                        }}
                    />
                    <DefaultButton
                        text="Cancel"
                        onClick={() => setKillTarget(null)}
                    />
                </DialogFooter>
            </Dialog>
        </>
    );
};

export default TunersManager;
