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
    ActionButton,
    ProgressIndicator,
    MessageBar,
    MessageBarType
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

interface ChannelScanStatus {
    status: "not_started" | "scanning" | "completed" | "cancelled" | "error";
    isScanning: boolean;
    type: ChannelType;
    dryRun: boolean;
    progress: number;
    currentChannel: string;
    scanLog: string[];
    newCount: number;
    takeoverCount: number;
    result: ConfigChannels;
    startTime: number;
    updateTime: number;
}

const Configurator: React.FC<{ uiState: UIState, uiStateEvents: EventEmitter }> = ({ uiState, uiStateEvents }) => {
    const [current, setCurrent] = useState<ConfigChannels>(null);
    const [editing, setEditing] = useState<ConfigChannels>(null);
    const [showSaveDialog, setShowSaveDialog] = useState<boolean>(false);
    const [saved, setSaved] = useState<boolean>(false);
    const [showScanDialog, setShowScanDialog] = useState<boolean>(false);
    const [scanType, setScanType] = useState<ChannelType>("GR");
    const [scanMinCh, setScanMinCh] = useState<string>("13"); // GRのデフォルト値
    const [scanMaxCh, setScanMaxCh] = useState<string>("62"); // GRのデフォルト値
    const [scanSkipCh, setScanSkipCh] = useState<string>(""); // スキップするチャンネル
    const [scanMinSubCh, setScanMinSubCh] = useState<string>("0");
    const [scanMaxSubCh, setScanMaxSubCh] = useState<string>("3");
    const [scanUseSubCh, setScanUseSubCh] = useState<boolean>(true);
    const [scanChannelNameFormatEnabled, setScanChannelNameFormatEnabled] = useState<boolean>(false);
    const [scanChannelNameFormat, setScanChannelNameFormat] = useState<string>("");
    const [scanSetDisabledOnAdd, setScanSetDisabledOnAdd] = useState<boolean>(false);
    const [scanAutoApply, setScanAutoApply] = useState<boolean>(false);
    const [scanRefresh, setScanRefresh] = useState<boolean>(false);
    const [scanStatus, setScanStatus] = useState<ChannelScanStatus | null>(null);
    const [scanInProgress, setScanInProgress] = useState<boolean>(false);
    const [showScanResultDialog, setShowScanResultDialog] = useState<boolean>(false);
    const listContainerRef = useRef<HTMLDivElement>(null);

    // チャンネルスキャンのステータスを取得する関数
    const fetchScanStatus = async () => {
        try {
            const res = await (await fetch("/api/config/channels/scan")).json();
            console.log("ChannelsConfigurator", "GET", "/api/config/channels/scan", "->", res);
            setScanStatus(res);
            setScanInProgress(res.isScanning);

            // スキャンが完了したら結果ダイアログを表示
            if (res.status === "completed" && scanInProgress && !res.isScanning) {
                setShowScanResultDialog(true);
                setScanInProgress(false);
            }
        } catch (e) {
            console.error("Failed to fetch scan status:", e);
        }
    };

    // チャンネル範囲を展開する関数（例: "14-16,18" → "14,15,16,18"）
    const expandChannelRanges = (input: string): string => {
        if (!input) return "";

        const parts = input.split(',');
        const result: number[] = [];

        for (const part of parts) {
            if (part.includes('-')) {
                // 範囲指定の処理
                const [start, end] = part.split('-').map(n => parseInt(n.trim(), 10));
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = start; i <= end; i++) {
                        result.push(i);
                    }
                }
            } else {
                // 単一の数値の処理
                const num = parseInt(part.trim(), 10);
                if (!isNaN(num)) {
                    result.push(num);
                }
            }
        }

        // 重複を削除して昇順にソート
        return [...new Set(result)].sort((a, b) => a - b).join(',');
    };

    // スキャンを開始する関数
    const startScan = async () => {
        try {
            const params = new URLSearchParams();
            params.append("type", scanType);
            params.append("minCh", scanMinCh);
            params.append("maxCh", scanMaxCh);

            // スキップするチャンネルがある場合は追加
            if (scanSkipCh.trim()) {
                // 範囲指定（例：14-16）を展開する
                const expandedSkipCh = expandChannelRanges(scanSkipCh.trim());
                params.append("skipCh", expandedSkipCh);
            }

            if (scanType === "BS" && scanUseSubCh) {
                params.append("minSubCh", scanMinSubCh);
                params.append("maxSubCh", scanMaxSubCh);
                params.append("useSubCh", "true");
            }

            // 自動適用がオフの場合はドライランモードを使用
            if (!scanAutoApply) {
                params.append("dryRun", "true");
            }

            // channelNameFormat が有効な場合のみ追加
            if (scanChannelNameFormatEnabled && scanChannelNameFormat.trim()) {
                params.append("channelNameFormat", scanChannelNameFormat.trim());
            }

            // setDisabledOnAdd を追加
            params.append("setDisabledOnAdd", scanSetDisabledOnAdd ? "true" : "false");

            if (scanRefresh) {
                params.append("refresh", "true");
            }

            // 非同期スキャンを使用
            params.append("async", "true");

            const url = `/api/config/channels/scan?${params.toString()}`;
            console.log("ChannelsConfigurator", "PUT", url);

            const response = await fetch(url, { method: "PUT" });
            const result = await response.json();

            if (response.status === 202) {
                console.log("Scan started:", result);
                setScanInProgress(true);
                setShowScanDialog(false);

                // ステータスポーリングを開始
                await fetchScanStatus();
            } else {
                console.error("Failed to start scan:", result);
            }
        } catch (e) {
            console.error("Error starting scan:", e);
        }
    };

    // スキャンを停止する関数
    const stopScan = async () => {
        try {
            const response = await fetch("/api/config/channels/scan", { method: "DELETE" });
            console.log("ChannelsConfigurator", "DELETE", "/api/config/channels/scan", "->", await response.json());
            setScanInProgress(false);
        } catch (e) {
            console.error("Error stopping scan:", e);
        }
    };

    // スキャン結果を適用する関数
    const applyScanResult = () => {
        if (scanStatus && scanStatus.result) {
            setEditing(JSON.parse(JSON.stringify(scanStatus.result)));
            setShowScanResultDialog(false);
        }
    };

    useEffect(() => {
        if (saved === true) {
            setTimeout(() => {
                uiStateEvents.emit("notify:restart-required");
            }, 500);
            setSaved(false);
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
    }, [saved]);

    // コンポーネントがマウントされたときにスキャン状態を確認
    useEffect(() => {
        fetchScanStatus();
    }, []);

    // スキャン状態を定期的に更新（スキャン中は5秒、それ以外は30秒ごと）
    useEffect(() => {
        let intervalId: NodeJS.Timeout;

        if (scanInProgress) {
            // スキャン中は5秒ごとに更新
            intervalId = setInterval(fetchScanStatus, 5000);
        } else {
            // スキャン中でなくても30秒ごとに更新（完了したスキャンの結果を取得するため）
            intervalId = setInterval(fetchScanStatus, 30000);
        }

        return () => {
            if (intervalId) {
                clearInterval(intervalId);
            }
        };
    }, [scanInProgress]);

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
                            label="Satellite:"
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
                        <TextField
                            style={{ width: 60 }}
                            label="Freq:"
                            value={`${ch.freq || ""}`}
                            onChange={(ev, newValue) => {
                                if (newValue === "") {
                                    delete ch.freq;
                                } else if (/^[0-9\.]+$/.test(newValue)) {
                                    const freq = parseFloat(newValue);
                                    ch.freq = freq;
                                }
                                setEditing([...editing]);
                            }}
                        />
                        <Dropdown
                            label="Polarity:"
                            options={[
                                { key: "-", text: "-" },
                                { key: "H", text: "H" },
                                { key: "V", text: "V" }
                            ]}
                            selectedKey={ch.polarity || "-"}
                            onChange={(ev, option) => {
                                if (option.key === "-") {
                                    delete ch.polarity;
                                } else {
                                    ch.polarity = option.key as any;
                                }
                                setEditing([...editing]);
                            }}
                        />
                        <TextField
                            style={{ width: 40 }}
                            label="TsmfRelTs:"
                            value={`${ch.tsmfRelTs || ""}`}
                            onChange={(ev, newValue) => {
                                if (newValue === "") {
                                    delete ch.tsmfRelTs;
                                } else if (/^[0-9]+$/.test(newValue)) {
                                    const tsmfRelTs = parseInt(newValue, 10);
                                    ch.tsmfRelTs = tsmfRelTs;
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
                    <Stack horizontal tokens={{ childrenGap: "0 8" }}>
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
                                    setTimeout(() => {
                                        listContainerRef.current.scrollTop = listContainerRef.current.scrollHeight;
                                    }, 0);
                                }}
                            />
                        </Stack.Item>
                        <Stack.Item>
                            <ActionButton
                                text="Channel Scan"
                                iconProps={{ iconName: "Search" }}
                                onClick={() => setShowScanDialog(true)}
                                disabled={scanInProgress}
                            />
                        </Stack.Item>
                        <Stack.Item>
                            <ActionButton
                                text={scanInProgress ? "Scanning..." : "Get Scan Status"}
                                iconProps={{ iconName: "Refresh" }}
                                onClick={fetchScanStatus}
                            />
                        </Stack.Item>
                        {scanStatus && scanStatus.scanLog && scanStatus.scanLog.length > 0 && (
                            <Stack.Item>
                                <ActionButton
                                    text="View Scan Results"
                                    iconProps={{ iconName: "TextDocument" }}
                                    onClick={() => setShowScanResultDialog(true)}
                                />
                            </Stack.Item>
                        )}
                        {scanStatus?.status === "completed" && scanStatus.result && !scanInProgress && (
                            <Stack.Item>
                                <ActionButton
                                    text="Apply Scan Results"
                                    iconProps={{ iconName: "CheckMark" }}
                                    onClick={applyScanResult}
                                />
                            </Stack.Item>
                        )}
                        {scanInProgress && (
                            <Stack.Item>
                                <ActionButton
                                    text="Stop Scan"
                                    iconProps={{ iconName: "Stop" }}
                                    onClick={stopScan}
                                />
                            </Stack.Item>
                        )}
                    </Stack>

                    {scanInProgress && scanStatus && (
                        <Stack tokens={{ childrenGap: "8 0" }}>
                            <ProgressIndicator
                                label={`Scanning ${scanStatus.type} channels...`}
                                description={`Current Channel: ${scanStatus.currentChannel || "Initializing..."}`}
                                percentComplete={scanStatus.progress / 100}
                            />
                            <Stack horizontal verticalAlign="center">
                                <Spinner size={SpinnerSize.small} labelPosition="right" label={`New: ${scanStatus.newCount}, Takeover: ${scanStatus.takeoverCount}`} />
                            </Stack>
                        </Stack>
                    )}

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

            {/* チャンネルスキャンダイアログ */}
            <Dialog
                hidden={!showScanDialog}
                onDismiss={() => setShowScanDialog(false)}
                dialogContentProps={{
                    type: DialogType.largeHeader,
                    title: "Channel Scan",
                    subText: "Configure scan parameters and click Start to begin scanning."
                }}
                modalProps={{
                    isBlocking: true,
                    styles: { main: { maxWidth: 450 } }
                }}
            >
                <Stack tokens={{ childrenGap: "12 0" }}>
                    <Dropdown
                        label="Channel Type"
                        options={[
                            { key: "GR", text: "GR" },
                            { key: "BS", text: "BS" },
                            { key: "CS", text: "CS" }
                        ]}
                        selectedKey={scanType}
                        onChange={(ev, option) => {
                            const newType = option.key as ChannelType;
                            setScanType(newType);

                            // チャンネルタイプに応じてデフォルト値を設定
                            switch (newType) {
                                case "GR":
                                    setScanMinCh("13");
                                    setScanMaxCh("62");
                                    break;
                                case "BS":
                                    setScanMinCh("1");
                                    setScanMaxCh("23");
                                    break;
                                case "CS":
                                    setScanMinCh("2");
                                    setScanMaxCh("24");
                                    break;
                            }
                        }}
                    />

                    <Stack horizontal tokens={{ childrenGap: "0 8" }}>
                        <TextField
                            label="Min Channel"
                            value={scanMinCh}
                            onChange={(ev, val) => setScanMinCh(val)}
                            styles={{ root: { width: 100 } }}
                        />
                        <TextField
                            label="Max Channel"
                            value={scanMaxCh}
                            onChange={(ev, val) => setScanMaxCh(val)}
                            styles={{ root: { width: 100 } }}
                        />
                    </Stack>

                    <TextField
                        label="Skip Channels (comma separated integers)"
                        placeholder="Example: 13,14-16,18"
                        value={scanSkipCh}
                        onChange={(ev, val) => {
                            // Allow numbers, commas, and hyphens
                            if (val === "" || /^[0-9,\-]+$/.test(val)) {
                                setScanSkipCh(val);
                            }
                        }}
                        description="Enter channel numbers to skip during scanning. Range notation (e.g. 14-16) is supported."
                        styles={{ root: { width: '100%' } }}
                    />

                    {scanType === "BS" && (
                        <>
                            <Toggle
                                label="Use Subchannel Style (BS01_0)"
                                checked={scanUseSubCh}
                                onChange={(ev, checked) => setScanUseSubCh(checked)}
                            />

                            {scanUseSubCh && (
                                <Stack horizontal tokens={{ childrenGap: "0 8" }}>
                                    <TextField
                                        label="Min Subchannel"
                                        value={scanMinSubCh}
                                        onChange={(ev, val) => setScanMinSubCh(val)}
                                        styles={{ root: { width: 100 } }}
                                    />
                                    <TextField
                                        label="Max Subchannel"
                                        value={scanMaxSubCh}
                                        onChange={(ev, val) => setScanMaxSubCh(val)}
                                        styles={{ root: { width: 100 } }}
                                    />
                                </Stack>
                            )}
                        </>
                    )}

                    <Toggle
                        label="Use Channel Name Format"
                        checked={scanChannelNameFormatEnabled}
                        onChange={(ev, checked) => setScanChannelNameFormatEnabled(checked)}
                    />

                    {scanChannelNameFormatEnabled && (
                        <TextField
                            label="Channel Name Format"
                            placeholder="Example: {ch}, BS{ch00}_{subch}"
                            description="Format to use for channel names. Supports placeholders like {ch}, {ch00}, {subch}."
                            value={scanChannelNameFormat}
                            onChange={(ev, val) => setScanChannelNameFormat(val)}
                            styles={{ root: { width: '100%' } }}
                        />
                    )}

                    <Toggle
                        label="Auto Apply Results (Restart required)"
                        checked={scanAutoApply}
                        onChange={(ev, checked) => setScanAutoApply(checked)}
                    />

                    <Toggle
                        label="Set Disabled on Add"
                        checked={scanSetDisabledOnAdd}
                        onChange={(ev, checked) => setScanSetDisabledOnAdd(checked)}
                    />

                    <Toggle
                        label="Refresh (Update existing channels)"
                        checked={scanRefresh}
                        onChange={(ev, checked) => setScanRefresh(checked)}
                    />
                </Stack>

                <DialogFooter>
                    <PrimaryButton text="Start Scan" onClick={startScan} />
                    <DefaultButton text="Cancel" onClick={() => setShowScanDialog(false)} />
                </DialogFooter>
            </Dialog>

            {/* スキャン結果ダイアログ */}
            <Dialog
                hidden={!showScanResultDialog}
                onDismiss={() => setShowScanResultDialog(false)}
                dialogContentProps={{
                    type: DialogType.largeHeader,
                    title: "Scan Results",
                    subText: scanStatus ? `New: ${scanStatus.newCount}, Takeover: ${scanStatus.takeoverCount}` : ""
                }}
                modalProps={{
                    isBlocking: true,
                    styles: { main: { minWidth: 600 } }
                }}
            >
                {scanStatus && (
                    <Stack tokens={{ childrenGap: "12 0" }}>
                        {scanStatus.status === "completed" && (
                            <MessageBar messageBarType={MessageBarType.success}>
                                Scan completed successfully!
                            </MessageBar>
                        )}

                        <div style={{ maxHeight: "300px", overflowY: "auto", border: "1px solid #eee", padding: "8px" }}>
                            {scanStatus.scanLog && scanStatus.scanLog.length > 0 ? (
                                scanStatus.scanLog.map((log, i) => (
                                    <div key={i}>{log}</div>
                                ))
                            ) : (
                                <div>No scan logs available</div>
                            )}
                        </div>

                        {scanStatus.status === "completed" && scanStatus.result && (
                            <MessageBar messageBarType={MessageBarType.info}>
                                Click "Apply Results" to update your channel configuration with these scan results.
                            </MessageBar>
                        )}
                    </Stack>
                )}

                <DialogFooter>
                    <PrimaryButton
                        text="Apply Results"
                        onClick={applyScanResult}
                        disabled={scanStatus?.status !== "completed" || !scanStatus?.result}
                    />
                    <DefaultButton text="Close" onClick={() => setShowScanResultDialog(false)} />
                </DialogFooter>
            </Dialog>
        </>
    );
};

export default Configurator;
