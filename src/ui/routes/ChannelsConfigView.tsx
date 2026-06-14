/*
   Copyright 2026 kanreisa

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
    Alignment,
    Breadcrumbs,
    Button,
    Callout,
    Dialog,
    DialogBody,
    DialogFooter,
    FormGroup,
    HTMLSelect,
    HTMLTable,
    InputGroup,
    Navbar,
    NonIdealState,
    ProgressBar,
    Spinner,
    Switch
} from "@blueprintjs/core";
import equal from "fast-deep-equal";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import { ConfigChannels, ConfigChannelsItem, ChannelType, ChannelScanStatus } from "../../../api.d";

import "./ChannelsConfigView.sass";

const configAPI = "/api/config/channels";
const typesIndex = ["GR", "BS", "CS", "SKY"];

function sortTypes(types: ChannelType[]): ChannelType[] {
    return types.sort((a, b) => typesIndex.indexOf(a) - typesIndex.indexOf(b));
}

// チャンネル範囲を展開する関数（例: "14-16,18" → "14,15,16,18"）
function expandChannelRanges(input: string): string {
    if (!input) return "";

    const parts = input.split(",");
    const result: number[] = [];

    for (const part of parts) {
        if (part.includes("-")) {
            const [start, end] = part.split("-").map(n => parseInt(n.trim(), 10));
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = start; i <= end; i++) {
                    result.push(i);
                }
            }
        } else {
            const num = parseInt(part.trim(), 10);
            if (!isNaN(num)) {
                result.push(num);
            }
        }
    }

    return [...new Set(result)].sort((a, b) => a - b).join(",");
}

const migrateChannels = (channels: ConfigChannels): ConfigChannels => {
    return channels.map(ch => {
        if ((ch.satellite || ch.space !== undefined || ch.freq !== undefined || ch.polarity) && (!ch.commandVars || Object.keys(ch.commandVars).length === 0)) {
            const commandVars: Record<string, string | number> = {};
            if (ch.satellite) {
                commandVars["satellite"] = ch.satellite;
            }
            if (ch.space !== undefined) {
                commandVars["space"] = ch.space;
            }
            if (ch.freq !== undefined) {
                commandVars["freq"] = ch.freq;
            }
            if (ch.polarity) {
                commandVars["polarity"] = ch.polarity;
            }
            return {
                ...ch,
                commandVars
            };
        }
        return ch;
    });
};

export const ChannelsConfigView: React.FC = () => {
    console.debug("routes", "ChannelsConfigView");

    const [current, setCurrent] = useState<ConfigChannels | null>(null);
    const [editing, setEditing] = useState<ConfigChannels | null>(null);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [saved, setSaved] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // チャンネルスキャンのためのステート
    const [showScanDialog, setShowScanDialog] = useState(false);
    const [scanType, setScanType] = useState<ChannelType>("GR");
    const [scanMinCh, setScanMinCh] = useState("13");
    const [scanMaxCh, setScanMaxCh] = useState("62");
    const [scanSkipCh, setScanSkipCh] = useState("");
    const [scanMinSubCh, setScanMinSubCh] = useState("0");
    const [scanMaxSubCh, setScanMaxSubCh] = useState("3");
    const [scanUseSubCh, setScanUseSubCh] = useState(true);
    const [scanChannelNameFormatEnabled, setScanChannelNameFormatEnabled] = useState(false);
    const [scanChannelNameFormat, setScanChannelNameFormat] = useState("");
    const [scanSetDisabledOnAdd, setScanSetDisabledOnAdd] = useState(false);
    const [scanAutoApply, setScanAutoApply] = useState(false);
    const [scanRefresh, setScanRefresh] = useState(false);
    const [scanStatus, setScanStatus] = useState<ChannelScanStatus | null>(null);
    const [scanInProgress, setScanInProgress] = useState(false);
    const [showScanResultDialog, setShowScanResultDialog] = useState(false);

    ui.setTitle("チャンネル設定", isLoading);

    // スキャンステータスを取得する
    const fetchScanStatus = async () => {
        try {
            const res: ChannelScanStatus = await (await fetch("/api/config/channels/scan")).json();
            console.log("ChannelsConfigView", "GET", "/api/config/channels/scan", "->", res);
            setScanStatus(res);

            setScanInProgress(prev => {
                if (res.status === "completed" && prev && !res.isScanning) {
                    setShowScanResultDialog(true);
                }
                return res.isScanning;
            });
        } catch (e) {
            console.error("Failed to fetch scan status:", e);
        }
    };

    // スキャンを開始する
    const startScan = async () => {
        try {
            const params = new URLSearchParams();
            params.append("type", scanType);
            params.append("minCh", scanMinCh);
            params.append("maxCh", scanMaxCh);

            if (scanSkipCh.trim()) {
                const expandedSkipCh = expandChannelRanges(scanSkipCh.trim());
                params.append("skipCh", expandedSkipCh);
            }

            if (scanType === "BS" && scanUseSubCh) {
                params.append("minSubCh", scanMinSubCh);
                params.append("maxSubCh", scanMaxSubCh);
                params.append("useSubCh", "true");
            }

            if (!scanAutoApply) {
                params.append("dryRun", "true");
            }

            if (scanChannelNameFormatEnabled && scanChannelNameFormat.trim()) {
                params.append("channelNameFormat", scanChannelNameFormat.trim());
            }

            params.append("setDisabledOnAdd", scanSetDisabledOnAdd ? "true" : "false");

            if (scanRefresh) {
                params.append("refresh", "true");
            }

            params.append("async", "true");

            const url = `/api/config/channels/scan?${params.toString()}`;
            console.log("ChannelsConfigView", "PUT", url);

            const response = await fetch(url, { method: "PUT" });
            const result = await response.json();

            if (response.status === 202) {
                console.log("Scan started:", result);
                setScanInProgress(true);
                setShowScanDialog(false);
                await fetchScanStatus();
            } else {
                console.error("Failed to start scan:", result);
            }
        } catch (e) {
            console.error("Error starting scan:", e);
        }
    };

    // スキャンを停止する
    const stopScan = async () => {
        try {
            const response = await fetch("/api/config/channels/scan", { method: "DELETE" });
            console.log("ChannelsConfigView", "DELETE", "/api/config/channels/scan", "->", await response.json());
            setScanInProgress(false);
        } catch (e) {
            console.error("Error stopping scan:", e);
        }
    };

    // スキャン結果を適用する
    const applyScanResult = () => {
        if (scanStatus && scanStatus.result) {
            setEditing(JSON.parse(JSON.stringify(scanStatus.result)));
            setShowScanResultDialog(false);
        }
    };

    // 初期データ読み込み
    useEffect(() => {
        if (saved === true) {
            setTimeout(() => {
                // Restart notification will be emitted in production when requested
            }, 500);
            setSaved(false);
            return;
        }

        (async () => {
            try {
                const res = await (await fetch(configAPI)).json();
                console.log("ChannelsConfigView", "GET", configAPI, "->", res);
                const migrated = migrateChannels(res);
                setEditing(JSON.parse(JSON.stringify(migrated)));
                setCurrent(JSON.parse(JSON.stringify(migrated)));
                setIsLoading(false);
            } catch (e) {
                console.error(e);
                setIsLoading(false);
            }
        })();
    }, [saved]);

    // スキャン状態の定期チェック
    useEffect(() => {
        fetchScanStatus();
    }, [current]);

    useEffect(() => {
        let intervalId: NodeJS.Timeout;
        if (scanInProgress) {
            intervalId = setInterval(fetchScanStatus, 5000);
        } else {
            intervalId = setInterval(fetchScanStatus, 30000);
        }
        return () => {
            if (intervalId) {
                clearInterval(intervalId);
            }
        };
    }, [scanInProgress]);

    const hasChanges = editing !== null && current !== null && !equal(editing, current);

    const handleCancel = () => {
        if (current) {
            setEditing(JSON.parse(JSON.stringify(current)));
        }
    };

    const handleSave = async () => {
        if (!editing) return;
        setShowSaveDialog(false);
        try {
            console.log("ChannelsConfigView", "PUT", configAPI, "<-", editing);
            await fetch(configAPI, {
                method: "PUT",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify(editing)
            });
            setSaved(true);
        } catch (err) {
            console.error(err);
        }
    };

    const handleAddChannel = () => {
        if (!editing) return;
        const i = editing.length;
        const newChannel: ConfigChannelsItem = {
            name: `ch${i}`,
            type: "GR",
            channel: "0",
            isDisabled: true
        };
        setEditing([...editing, newChannel]);
    };

    const updateChannel = (index: number, updated: Partial<ConfigChannelsItem>) => {
        if (!editing) return;
        const newEditing = [...editing];
        newEditing[index] = { ...newEditing[index], ...updated };
        setEditing(newEditing);
    };

    const deleteChannelProperty = (index: number, key: keyof ConfigChannelsItem) => {
        if (!editing) return;
        const newEditing = [...editing];
        const updated = { ...newEditing[index] };
        delete updated[key];
        newEditing[index] = updated;
        setEditing(newEditing);
    };

    const handleUp = (i: number) => {
        if (!editing || i === 0) return;
        const newEditing = [...editing];
        const temp = newEditing[i];
        newEditing[i] = newEditing[i - 1];
        newEditing[i - 1] = temp;
        setEditing(newEditing);
    };

    const handleDown = (i: number) => {
        if (!editing || i === editing.length - 1) return;
        const newEditing = [...editing];
        const temp = newEditing[i];
        newEditing[i] = newEditing[i + 1];
        newEditing[i + 1] = temp;
        setEditing(newEditing);
    };

    const handleRemove = (i: number) => {
        if (!editing) return;
        const newEditing = [...editing];
        newEditing.splice(i, 1);
        setEditing(newEditing);
    };

    // Command Var Helpers
    const updateCommandVarKey = (chIndex: number, oldKey: string, newKey: string) => {
        if (!editing) return;
        const newEditing = [...editing];
        const ch = { ...newEditing[chIndex] };
        const commandVars = { ...(ch.commandVars || {}) };

        const updatedVars: Record<string, string | number> = {};
        Object.entries(commandVars).forEach(([k, v]) => {
            if (k === oldKey) {
                updatedVars[newKey] = v;
            } else {
                updatedVars[k] = v;
            }
        });
        ch.commandVars = updatedVars;
        newEditing[chIndex] = ch;
        setEditing(newEditing);
    };

    const updateCommandVarValue = (chIndex: number, key: string, newValue: string) => {
        if (!editing) return;
        const newEditing = [...editing];
        const ch = { ...newEditing[chIndex] };
        const commandVars = { ...(ch.commandVars || {}) };

        if (newValue === "") {
            commandVars[key] = "";
        } else if (newValue === "0") {
            commandVars[key] = 0;
        } else if (/^[0-9]+(\.[0-9]+)?$/.test(newValue)) {
            commandVars[key] = parseFloat(newValue);
        } else {
            commandVars[key] = newValue;
        }
        ch.commandVars = commandVars;
        newEditing[chIndex] = ch;
        setEditing(newEditing);
    };

    const removeCommandVar = (chIndex: number, key: string) => {
        if (!editing) return;
        const newEditing = [...editing];
        const ch = { ...newEditing[chIndex] };
        const commandVars = { ...(ch.commandVars || {}) };
        delete commandVars[key];
        if (Object.keys(commandVars).length === 0) {
            delete ch.commandVars;
        } else {
            ch.commandVars = commandVars;
        }
        newEditing[chIndex] = ch;
        setEditing(newEditing);
    };

    const addCommandVar = (chIndex: number) => {
        if (!editing) return;
        const newEditing = [...editing];
        const ch = { ...newEditing[chIndex] };
        const commandVars = { ...(ch.commandVars || {}) };

        let newKey = "arg";
        let counter = 1;
        while (commandVars[newKey] !== undefined) {
            newKey = `arg${counter}`;
            counter++;
        }
        commandVars[newKey] = "";
        ch.commandVars = commandVars;
        newEditing[chIndex] = ch;
        setEditing(newEditing);
    };

    const toolbar = (
        <Navbar className="toolbar">
            <Navbar.Group align={Alignment.START}>
                <Navbar.Heading>
                    <Breadcrumbs items={[
                        {
                            text: "チャンネル設定"
                        }
                    ]} />
                </Navbar.Heading>
            </Navbar.Group>

            <Navbar.Group align={Alignment.END}>
                <Button
                    minimal
                    intent="success"
                    icon="add"
                    text="Add Channel"
                    onClick={handleAddChannel}
                />
                <Button
                    minimal
                    intent="warning"
                    icon="search"
                    text="Channel Scan"
                    onClick={() => setShowScanDialog(true)}
                    disabled={scanInProgress}
                />

                <Navbar.Divider />

                <Button
                    minimal
                    intent="danger"
                    icon="undo"
                    text="Cancel"
                    disabled={!hasChanges}
                    onClick={handleCancel}
                />
                <Button
                    intent="primary"
                    icon="saved"
                    text="Save"
                    disabled={!hasChanges}
                    onClick={() => setShowSaveDialog(true)}
                />
            </Navbar.Group>
        </Navbar>
    );

    if (isLoading || !editing) {
        return (
            <div className="route" id="route-channels-config-view">
                {toolbar}
                <NonIdealState
                    icon={<Spinner />}
                    title="ロード中"
                    description="設定を読み込んでいます..."
                />
            </div>
        );
    }

    return (
        <div className="route" id="route-channels-config-view">
            {toolbar}

            <div className="content">
                {/* スキャン進行中/完了時のステータス表示 */}
                {scanInProgress && scanStatus && (
                    <Callout intent="primary" title={`チャンネルスキャン中 (${scanStatus.type})`}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
                            <ProgressBar value={(scanStatus.progress || 0) / 100} />
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <div>
                                    現在のチャンネル: <strong>{scanStatus.currentChannel || "初期化中..."}</strong> (進捗: {scanStatus.progress || 0}%)
                                    <span style={{ marginLeft: "16px" }}>新規: {scanStatus.newCount || 0} / 引き継ぎ: {scanStatus.takeoverCount || 0}</span>
                                </div>
                                <div style={{ display: "flex", gap: "8px" }}>
                                    <Button small icon="refresh" onClick={fetchScanStatus}>更新</Button>
                                    <Button small intent="danger" icon="stop" onClick={stopScan}>スキャン停止</Button>
                                </div>
                            </div>
                        </div>
                    </Callout>
                )}

                {!scanInProgress && scanStatus && (scanStatus.status === "completed" || (scanStatus.scanLog && scanStatus.scanLog.length > 0)) && (
                    <Callout
                        intent={scanStatus.status === "completed" ? "success" : "warning"}
                        title={`前回のスキャン結果 (${scanStatus.type})`}
                    >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "8px" }}>
                            <div>
                                ステータス: <strong>{scanStatus.status}</strong>
                                <span style={{ marginLeft: "16px" }}>新規: {scanStatus.newCount || 0} / 引き継ぎ: {scanStatus.takeoverCount || 0}</span>
                            </div>
                            <div style={{ display: "flex", gap: "8px" }}>
                                {scanStatus.status === "completed" && scanStatus.result && (
                                    <Button small intent="success" icon="tick" onClick={applyScanResult}>スキャン結果を適用</Button>
                                )}
                                <Button small icon="document" onClick={() => setShowScanResultDialog(true)}>ログを表示</Button>
                            </div>
                        </div>
                    </Callout>
                )}

                <HTMLTable className="channels-table" striped interactive>
                    <thead>
                        <tr>
                            <th style={{ width: "80px" }}>Enable</th>
                            <th style={{ width: "160px" }}>Name</th>
                            <th style={{ width: "100px" }}>Type</th>
                            <th style={{ width: "120px" }}>Channel</th>
                            <th>Options</th>
                            <th style={{ width: "140px", textAlign: "right" }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {editing.map((ch, i) => (
                            <tr key={i}>
                                <td>
                                    <Switch
                                        checked={!ch.isDisabled}
                                        onChange={(e) => {
                                            updateChannel(i, { isDisabled: !e.currentTarget.checked });
                                        }}
                                    />
                                </td>
                                <td>
                                    <InputGroup
                                        value={ch.name || ""}
                                        onChange={(e) => {
                                            updateChannel(i, { name: e.target.value });
                                        }}
                                        onBlur={() => {
                                            if (ch.name === "") {
                                                updateChannel(i, { name: `ch${i}` });
                                            }
                                        }}
                                    />
                                </td>
                                <td>
                                    <HTMLSelect
                                        value={ch.type}
                                        onChange={(e) => {
                                            updateChannel(i, { type: e.target.value as ChannelType });
                                        }}
                                        options={[
                                            { value: "GR", label: "GR" },
                                            { value: "BS", label: "BS" },
                                            { value: "CS", label: "CS" },
                                            { value: "SKY", label: "SKY" }
                                        ]}
                                    />
                                </td>
                                <td>
                                    <InputGroup
                                        value={ch.channel || ""}
                                        onChange={(e) => {
                                            updateChannel(i, { channel: e.target.value });
                                        }}
                                        onBlur={() => {
                                            if (ch.channel === "") {
                                                updateChannel(i, { channel: "0" });
                                            }
                                        }}
                                    />
                                </td>
                                <td>
                                    <div className="channel-options-grid">
                                        <FormGroup label="Service ID" style={{ width: "90px", marginBottom: 0 }}>
                                            <InputGroup
                                                placeholder="SID"
                                                value={`${ch.serviceId || ""}`}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    if (val === "") {
                                                        deleteChannelProperty(i, "serviceId");
                                                    } else if (/^[0-9]+$/.test(val)) {
                                                        const sid = parseInt(val, 10);
                                                        if (sid <= 65535 && sid > 0) {
                                                            updateChannel(i, { serviceId: sid });
                                                        }
                                                    }
                                                }}
                                            />
                                        </FormGroup>

                                        <FormGroup label="TsmfRelTs" style={{ width: "90px", marginBottom: 0 }}>
                                            <InputGroup
                                                placeholder="TsmfRelTs"
                                                value={`${ch.tsmfRelTs || ""}`}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    if (val === "") {
                                                        deleteChannelProperty(i, "tsmfRelTs");
                                                    } else if (/^[0-9]+$/.test(val)) {
                                                        const tsmfRelTs = parseInt(val, 10);
                                                        updateChannel(i, { tsmfRelTs });
                                                    }
                                                }}
                                            />
                                        </FormGroup>

                                        <div className="cmd-vars-container">
                                            <div className="cmd-vars-title">Command Vars</div>
                                            <div className="cmd-vars-list">
                                                {ch.commandVars && Object.entries(ch.commandVars).map(([key, value]) => (
                                                    <div key={key} className="cmd-var-pair">
                                                        <InputGroup
                                                            small
                                                            className="cmd-var-key"
                                                            value={key}
                                                            onChange={(e) => updateCommandVarKey(i, key, e.target.value)}
                                                        />
                                                        <span className="cmd-var-separator">:</span>
                                                        <InputGroup
                                                            small
                                                            className="cmd-var-value"
                                                            value={`${value}`}
                                                            onChange={(e) => updateCommandVarValue(i, key, e.target.value)}
                                                        />
                                                        <Button
                                                            small
                                                            minimal
                                                            intent="danger"
                                                            icon="cross"
                                                            onClick={() => removeCommandVar(i, key)}
                                                        />
                                                    </div>
                                                ))}
                                                <Button
                                                    small
                                                    minimal
                                                    intent="primary"
                                                    icon="plus"
                                                    text="Add Var"
                                                    onClick={() => addCommandVar(i)}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td>
                                    <div className="controls-cell">
                                        <Button
                                            disabled={i === 0}
                                            icon="chevron-up"
                                            onClick={() => handleUp(i)}
                                            minimal
                                        />
                                        <Button
                                            disabled={i === editing.length - 1}
                                            icon="chevron-down"
                                            onClick={() => handleDown(i)}
                                            minimal
                                        />
                                        <Button
                                            icon="trash"
                                            intent="danger"
                                            onClick={() => handleRemove(i)}
                                            minimal
                                        />
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </HTMLTable>
            </div>

            {/* 保存確認ダイアログ */}
            <Dialog
                isOpen={showSaveDialog}
                onClose={() => setShowSaveDialog(false)}
                title="Save"
            >
                <DialogBody>
                    <p>設定を保存しますか？</p>
                    <p className="bp5-text-muted">適用するには再起動が必要です。</p>
                </DialogBody>
                <DialogFooter
                    actions={
                        <>
                            <Button onClick={() => setShowSaveDialog(false)}>キャンセル</Button>
                            <Button
                                intent="primary"
                                disabled={!hasChanges}
                                onClick={handleSave}
                            >
                                保存
                            </Button>
                        </>
                    }
                />
            </Dialog>

            {/* スキャン設定ダイアログ */}
            <Dialog
                isOpen={showScanDialog}
                onClose={() => setShowScanDialog(false)}
                title="Channel Scan"
                style={{ width: "450px" }}
            >
                <DialogBody>
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <FormGroup label="Channel Type">
                            <HTMLSelect
                                value={scanType}
                                onChange={(e) => {
                                    const newType = e.target.value as ChannelType;
                                    setScanType(newType);
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
                                options={[
                                    { value: "GR", label: "GR" },
                                    { value: "BS", label: "BS" },
                                    { value: "CS", label: "CS" }
                                ]}
                            />
                        </FormGroup>

                        <div style={{ display: "flex", gap: "16px" }}>
                            <FormGroup label="Min Channel" style={{ flex: 1 }}>
                                <InputGroup
                                    value={scanMinCh}
                                    onChange={(e) => setScanMinCh(e.target.value)}
                                />
                            </FormGroup>
                            <FormGroup label="Max Channel" style={{ flex: 1 }}>
                                <InputGroup
                                    value={scanMaxCh}
                                    onChange={(e) => setScanMaxCh(e.target.value)}
                                />
                            </FormGroup>
                        </div>

                        <FormGroup
                            label="Skip Channels (comma separated integers)"
                            helperText="Enter channel numbers to skip. Range notation (e.g. 14-16) is supported."
                        >
                            <InputGroup
                                placeholder="Example: 13,14-16,18"
                                value={scanSkipCh}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    if (val === "" || /^[0-9,\-]+$/.test(val)) {
                                        setScanSkipCh(val);
                                    }
                                }}
                            />
                        </FormGroup>

                        {scanType === "BS" && (
                            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <Switch
                                    label="Use Subchannel Style (BS01_0)"
                                    checked={scanUseSubCh}
                                    onChange={(e) => setScanUseSubCh(e.currentTarget.checked)}
                                />
                                {scanUseSubCh && (
                                    <div style={{ display: "flex", gap: "16px" }}>
                                        <FormGroup label="Min Subchannel" style={{ flex: 1 }}>
                                            <InputGroup
                                                value={scanMinSubCh}
                                                onChange={(e) => setScanMinSubCh(e.target.value)}
                                            />
                                        </FormGroup>
                                        <FormGroup label="Max Subchannel" style={{ flex: 1 }}>
                                            <InputGroup
                                                value={scanMaxSubCh}
                                                onChange={(e) => setScanMaxSubCh(e.target.value)}
                                            />
                                        </FormGroup>
                                    </div>
                                )}
                            </div>
                        )}

                        <Switch
                            label="Use Channel Name Format"
                            checked={scanChannelNameFormatEnabled}
                            onChange={(e) => setScanChannelNameFormatEnabled(e.currentTarget.checked)}
                        />

                        {scanChannelNameFormatEnabled && (
                            <FormGroup
                                label="Channel Name Format"
                                helperText="Format to use for channel names. Supports placeholders like {ch}, {ch00}, {subch}."
                            >
                                <InputGroup
                                    placeholder="Example: {ch}, BS{ch00}_{subch}"
                                    value={scanChannelNameFormat}
                                    onChange={(e) => setScanChannelNameFormat(e.target.value)}
                                />
                            </FormGroup>
                        )}

                        <Switch
                            label="Auto Apply Results (Restart required)"
                            checked={scanAutoApply}
                            onChange={(e) => setScanAutoApply(e.currentTarget.checked)}
                        />

                        <Switch
                            label="Set Disabled on Add"
                            checked={scanSetDisabledOnAdd}
                            onChange={(e) => setScanSetDisabledOnAdd(e.currentTarget.checked)}
                        />

                        <Switch
                            label="Refresh (Update existing channels)"
                            checked={scanRefresh}
                            onChange={(e) => setScanRefresh(e.currentTarget.checked)}
                        />
                    </div>
                </DialogBody>
                <DialogFooter
                    actions={
                        <>
                            <Button onClick={() => setShowScanDialog(false)}>Cancel</Button>
                            <Button intent="primary" onClick={startScan}>Start Scan</Button>
                        </>
                    }
                />
            </Dialog>

            {/* スキャン結果/ログダイアログ */}
            <Dialog
                isOpen={showScanResultDialog}
                onClose={() => setShowScanResultDialog(false)}
                title="Scan Results"
                style={{ width: "600px" }}
            >
                <DialogBody>
                    {scanStatus && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                            {scanStatus.status === "completed" && (
                                <Callout intent="success" title="スキャン完了">
                                    スキャンが正常に完了しました！
                                    <div>新規: {scanStatus.newCount} | 引き継ぎ: {scanStatus.takeoverCount}</div>
                                </Callout>
                            )}

                            <div style={{
                                maxHeight: "300px",
                                overflowY: "auto",
                                border: "1px solid rgba(0,0,0,0.1)",
                                padding: "8px",
                                fontFamily: "monospace",
                                fontSize: "12px",
                                whiteSpace: "pre-wrap",
                                backgroundColor: "rgba(0,0,0,0.02)"
                            }}>
                                {scanStatus.scanLog && scanStatus.scanLog.length > 0 ? (
                                    scanStatus.scanLog.join("\n")
                                ) : (
                                    <div>ログがありません。</div>
                                )}
                            </div>

                            {scanStatus.status === "completed" && scanStatus.result && (
                                <Callout intent="primary">
                                    「適用」ボタンをクリックすると、現在のスキャン結果を設定に反映します。
                                </Callout>
                            )}
                        </div>
                    )}
                </DialogBody>
                <DialogFooter
                    actions={
                        <>
                            <Button onClick={() => setShowScanResultDialog(false)}>閉じる</Button>
                            <Button
                                intent="primary"
                                onClick={applyScanResult}
                                disabled={scanStatus?.status !== "completed" || !scanStatus?.result}
                            >
                                スキャン結果を適用
                            </Button>
                        </>
                    }
                />
            </Dialog>
        </div>
    );
};
