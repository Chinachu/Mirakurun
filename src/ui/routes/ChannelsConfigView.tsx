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
import { useState, useEffect, useRef } from "react";
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
import { ConfigChannels, ConfigChannelsItem, ConfigTuners, ChannelType, ChannelRoute, ChannelScanStatus, ChannelScanMode, ChannelScanSource } from "../../../api.d";
import { channelRoutes, getChannelRouteLabel, getDefaultChannelRoute } from "../modules/constants";

import "./ChannelsConfigView.sass";

const configAPI = "/api/config/channels";
const typesIndex = ["GR", "BS", "CS", "SKY", "BS4K", "CATV"];
const satellitePresetRanges = [
    ...Array.from({ length: 23 }, (_, i) => {
        const channel = `BS${String(i + 1).padStart(2, "0")}`;
        return `${channel}_0-${channel}_3`;
    }),
    "CS2-CS24"
].join(", ");
const relativeTsErrorMessage = "相対TSは1以上15以下の整数で指定してください。";
const isValidRelativeTs = (value: number | undefined) => value === undefined || Number.isInteger(value) && value >= 1 && value <= 15;
const tsmfGroupIdErrorMessage = "TSMFグループIDは1以上255以下の整数で指定してください。";
const isValidTsmfGroupId = (value: number | undefined) => value === undefined || Number.isInteger(value) && value >= 1 && value <= 255;

function sortTypes(types: ChannelType[]): ChannelType[] {
    return types.sort((a, b) => typesIndex.indexOf(a) - typesIndex.indexOf(b));
}

// チャンネルの一覧を展開する関数 (同じ接頭辞の末尾の番号の範囲を展開し、チャンネル名はそのまま。例: "14-16,C18-C19,BS01_0-BS01_1" → ["14", "15", "16", "C18", "C19", "BS01_0", "BS01_1"])
function expandChannelRanges(input: string): string[] {
    if (!input.trim()) { return []; }
    const result = new Set<string>();
    let expandedCount = 0;
    const invalid = () => new Error("数値のチャンネルは0以上の整数で指定してください。範囲の端点は0以上65535以下とし、開始番号以上の終了番号を指定してください。");
    const addChannel = (channel: string) => {
        // 単体の数字名は周波数などの識別子なので上限を設けず、長い値も数値へ変換しない。
        // 4- や 13x は識別子として扱い、範囲の展開後も指数・小数・符号付き数値は拒否する。
        // APIは任意の識別子を受けるが、この範囲入力では数値の誤記による意図しない走査を防ぐ。
        if (!/^\d+$/.test(channel) && !Number.isNaN(Number(channel))) { throw invalid(); }
        result.add(channel);
    };
    for (const raw of input.split(",")) {
        const part = raw.trim();
        if (!part || part.length > 1024) { throw invalid(); }
        // the prefix of the end may be omitted (e.g. C13-20)
        const range = /^(.*?)(\d+)\s*-\s*(.*?)(\d+)$/.exec(part);
        // 終了側の接頭辞は省略できるが、開始側が数値のみでも終了側だけに名称の接頭辞は付けられない。
        // 1-2-3など数値と区切りだけの単体識別子は従来どおり扱う。
        if (range && range[3] !== "" && range[1] !== range[3]
            && (range[1] !== "" || /[^\d+.\s-]/.test(range[3]))) {
            throw new Error("範囲の開始と終了には同じ接頭辞を指定してください。異なる接頭辞のチャンネルは、同じ接頭辞の範囲に分けるか、カンマで区切って指定してください。");
        }
        if (range && (range[1] === range[3] || range[3] === "")) {
            // the digits of the start (zero padded, e.g. BS01-BS03 -> BS01, BS02, BS03)
            const start = Number(range[2]);
            const end = Number(range[4]);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > 65535 || start > end) { throw invalid(); }
            expandedCount += end - start + 1;
            if (expandedCount > 4096) { throw new Error("スキップまたは取得するチャンネルは、重複を含む展開後の件数を4096件以下にしてください。"); }
            for (let i = start; i <= end; i++) {
                addChannel(`${range[1]}${String(i).padStart(range[2].length, "0")}`);
            }
        } else {
            if (++expandedCount > 4096) { throw new Error("スキップまたは取得するチャンネルは、重複を含む展開後の件数を4096件以下にしてください。"); }
            addChannel(part);
        }
    }

    return [...result];
}

const migrateChannels = (channels: ConfigChannels): ConfigChannels => {
    return channels.map(ch => {
        // 旧サーバーが返す0・null・空文字は読込時だけ未指定へ移す。新しい入力は範囲検証で拒否する。
        const relTs: unknown = ch.tsmfRelTs;
        if (relTs === 0 || relTs === null || relTs === "") {
            ch = { ...ch };
            delete ch.tsmfRelTs;
        }
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

// dvbv5-zap のチューナーは、チャンネル設定ファイルにないチャンネルを選局できない。
// 衛星はプリセットに放送されていないチャンネルが多く (SKY はプリセットがない)、チャンネル設定ファイルのほうが速いため、既定にする
const dvbConfDefaultTypes: Partial<Record<ChannelRoute, ChannelType[]>> = {
    SAT: ["BS", "CS", "BS4K"],
    SKY: ["SKY"]
};

/** スキャンに使うチューナーがすべて dvbv5-zap の場合は、チャンネル設定ファイルを既定にする */
function getDefaultScanSource(route: ChannelRoute, tuners: ConfigTuners): ChannelScanSource {
    // SKYにはプリセットがないため、対象名を入力できる一覧を初期値にする。
    const fallback = route === "SKY" ? "list" : "preset";
    const types = dvbConfDefaultTypes[route];
    if (!types) {
        return fallback;
    }
    const used = tuners.filter(tuner => (
        tuner.isDisabled !== true &&
        (tuner.types || []).some(type => types.includes(type)) &&
        (!tuner.routes || tuner.routes.includes(route))
    ));
    return used.length > 0 && used.every(tuner => tuner.remoteMirakurunHost === undefined && /^(\S*\/)?dvbv5-zap\s/.test(tuner.command || "")) ? "dvbConf" : fallback;
}

export const ChannelsConfigView: React.FC = () => {
    console.debug("routes", "ChannelsConfigView");

    const [current, setCurrent] = useState<ConfigChannels | null>(null);
    const [editing, setEditing] = useState<ConfigChannels | null>(null);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [saved, setSaved] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // チャンネルスキャンのためのステート
    const [showScanDialog, setShowScanDialog] = useState(false);
    const [scanRoute, setScanRoute] = useState<ChannelRoute>("TER");
    const [scanSource, setScanSource] = useState<ChannelScanSource>("preset");
    const [scanTuners, setScanTuners] = useState<ConfigTuners>([]);
    const [scanTunersError, setScanTunersError] = useState<string>();
    const [scanError, setScanError] = useState<string | null>(null);
    // 経路を選んだ後に、ソースを手動で選んだか
    const scanSourceChosen = useRef(false);
    const scanTunersRequest = useRef(0);
    const scanTunersController = useRef<AbortController>(undefined);
    useEffect(() => () => {
        ++scanTunersRequest.current;
        scanTunersController.current?.abort();
        scanTunersController.current = undefined;
    }, []);
    const [scanChannels, setScanChannels] = useState("");
    const [scanChannelNameFormat, setScanChannelNameFormat] = useState("C{ch}");
    const [scanMinCh, setScanMinCh] = useState("13");
    const [scanMaxCh, setScanMaxCh] = useState("63");
    const [scanMinSubCh, setScanMinSubCh] = useState("0");
    const [scanMaxSubCh, setScanMaxSubCh] = useState("3");
    const [scanSkipCh, setScanSkipCh] = useState("");
    const [scanMode, setScanMode] = useState<ChannelScanMode | "">("");
    // Autoでは値を送らず、新規サービス行をGRは有効・ほかは無効にするサーバー既定へ委ねる。
    const [scanSetDisabledOnAdd, setScanSetDisabledOnAdd] = useState<"" | "true" | "false">("");
    const [scanAutoApply, setScanAutoApply] = useState(false);
    const [scanRefresh, setScanRefresh] = useState(false);
    const [scanStatus, setScanStatus] = useState<ChannelScanStatus | null>(null);
    const [scanInProgress, setScanInProgress] = useState(false);
    const [isStartingScan, setIsStartingScan] = useState(false);
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

    const openScanDialog = async () => {
        setScanError(null);
        setScanTunersError(undefined);
        setShowScanDialog(true);
        const generation = ++scanTunersRequest.current;
        scanTunersController.current?.abort();
        const controller = new AbortController();
        scanTunersController.current = controller;
        try {
            const res = await fetch("/api/config/tuners", { signal: controller.signal });
            const tuners: ConfigTuners = await res.json();
            console.log("ChannelsConfigView", "GET", "/api/config/tuners", "->", tuners);
            if (!res.ok) { throw new Error(`${res.status} ${res.statusText}`); }
            if (generation === scanTunersRequest.current && Array.isArray(tuners)) {
                // 変わっていなければ、選んだソースをそのままにする
                setScanTuners(prev => equal(prev, tuners) ? prev : tuners);
            }
        } catch (e) {
            // 推奨スキャン元の取得失敗は、開始要求の受付結果を変更しない。
            if (generation === scanTunersRequest.current) { setScanTunersError(e instanceof Error ? e.message : String(e)); }
        } finally {
            if (scanTunersController.current === controller) { scanTunersController.current = undefined; }
        }
    };
    const closeScanDialog = () => {
        ++scanTunersRequest.current;
        scanTunersController.current?.abort();
        scanTunersController.current = undefined;
        setScanTunersError(undefined);
        setShowScanDialog(false);
    };

    // プリセットとチャンネル設定ファイルは、経路かチューナーが変わったら選び直す
    // (手動で選んだ後は、経路を変えるまでそのままにする。一覧と書式は入力した内容があるため、そのままにする)
    useEffect(() => {
        // 開始中は送信した条件を固定し、失敗の後に取得済みの推奨ソースを反映する。
        if (scanSourceChosen.current || isStartingScan || scanInProgress) {
            return;
        }
        setScanSource(source => source === "preset" || source === "dvbConf" || source === "list" && !scanChannels.trim()
            ? getDefaultScanSource(scanRoute, scanTuners) : source);
    }, [scanRoute, scanTuners, isStartingScan, scanInProgress, scanChannels]);

    // スキャンを開始する
    const startScan = async () => {
        setIsStartingScan(true);
        setScanTunersError(undefined);
        setScanError(null);
        try {
            if (scanRoute === "SKY" && scanSource === "preset") {
                throw new Error("SKYにはプリセットがありません。チャンネル一覧、dvbv5設定ファイル、または書式を指定してください。");
            }
            if (scanSource === "list" && !scanChannels.trim()) { throw new Error("スキャンするチャンネルを1件以上指定してください。"); }
            if (scanSource === "format" && !scanChannelNameFormat.trim()) { throw new Error("チャンネル名の書式を指定してください。"); }
            const params = new URLSearchParams();
            params.append("route", scanRoute);
            params.append("source", scanSource);

            if (scanSource === "list") {
                params.append("channels", expandChannelRanges(scanChannels).join(","));
            }

            if (scanSource === "format") {
                params.append("channelNameFormat", scanChannelNameFormat.trim());
                params.append("minCh", scanMinCh);
                params.append("maxCh", scanMaxCh);
                if (/{subch0*}/.test(scanChannelNameFormat)) {
                    params.append("minSubCh", scanMinSubCh);
                    params.append("maxSubCh", scanMaxSubCh);
                }
            }

            if (scanSkipCh.trim()) {
                params.append("skipCh", expandChannelRanges(scanSkipCh).join(","));
            }

            if (scanMode !== "") {
                params.append("scanMode", scanMode);
            }

            if (scanSetDisabledOnAdd !== "") {
                params.append("setDisabledOnAdd", scanSetDisabledOnAdd);
            }

            if (!scanAutoApply) {
                params.append("dryRun", "true");
            }

            if (scanRefresh) {
                params.append("refresh", "true");
            }

            params.append("async", "true");

            const url = `/api/config/channels/scan?${params.toString()}`;
            // URLSearchParamsの符号化済みURLはASCII。Nodeの既定16KiBにヘッダー用の余裕を残す。
            if (url.length > 8192) {
                throw new Error("スキャン条件が長すぎます。チャンネル一覧やスキップの指定を短くしてから、再度開始してください。");
            }
            console.log("ChannelsConfigView", "PUT", url);

            const response = await fetch(url, { method: "PUT" });
            const result = await response.json();

            if (response.status === 202) {
                console.log("Scan started:", result);
                setScanInProgress(true);
                closeScanDialog();
                await fetchScanStatus();
            } else {
                console.error("Failed to start scan:", result);
                setScanError(result?.reason || `${response.status} ${response.statusText}`);
            }
        } catch (e) {
            console.error("Error starting scan:", e);
            setScanError(String(e));
        } finally {
            setIsStartingScan(false);
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
            setEditing(migrateChannels(JSON.parse(JSON.stringify(scanStatus.result))));
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
    const hasInvalidRelativeTs = editing?.some(channel => !isValidRelativeTs(channel.tsmfRelTs));
    const hasInvalidTsmfGroupId = editing?.some(channel => !isValidTsmfGroupId(channel.tsmfGroupId));

    const handleCancel = () => {
        if (current) {
            setEditing(JSON.parse(JSON.stringify(current)));
        }
    };

    const handleSave = async () => {
        if (!editing || hasInvalidRelativeTs || hasInvalidTsmfGroupId) { return; }
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
                    onClick={openScanDialog}
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
                    disabled={!hasChanges || hasInvalidRelativeTs || hasInvalidTsmfGroupId}
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
                    <Callout intent="primary" title={`チャンネルスキャン中${scanStatus.route ? ` (${getChannelRouteLabel(scanStatus.route)})` : ""}`}>
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
                        title={`前回のスキャン結果${scanStatus.route ? ` (${getChannelRouteLabel(scanStatus.route)})` : ""}`}
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
                                            { value: "SKY", label: "SKY" },
                                            { value: "BS4K", label: "BS4K" },
                                            { value: "CATV", label: "CATV" }
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
                                        <FormGroup label="Route" style={{ width: "210px", marginBottom: 0 }}>
                                            <HTMLSelect
                                                value={ch.route || ""}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    if (val === "") {
                                                        deleteChannelProperty(i, "route");
                                                    } else {
                                                        updateChannel(i, { route: val as ChannelRoute });
                                                    }
                                                }}
                                                options={[
                                                    // 未指定 (タイプの既定の経路)
                                                    { value: "", label: `既定: ${getChannelRouteLabel(getDefaultChannelRoute(ch.type))}` },
                                                    ...channelRoutes.map(route => ({ value: route, label: getChannelRouteLabel(route) }))
                                                ]}
                                            />
                                        </FormGroup>

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

                                        <FormGroup label="TsmfRelTs" style={{ width: "90px", marginBottom: 0 }}
                                            intent={isValidRelativeTs(ch.tsmfRelTs) ? undefined : "danger"}
                                            helperText={isValidRelativeTs(ch.tsmfRelTs) ? undefined : `${i + 1}行目: ${relativeTsErrorMessage}`}>
                                            <InputGroup
                                                placeholder="TsmfRelTs"
                                                type="number" min={1} max={15} step={1}
                                                value={Number.isNaN(ch.tsmfRelTs) ? "" : `${ch.tsmfRelTs ?? ""}`}
                                                onInput={(e) => {
                                                    const val = e.currentTarget.value;
                                                    // 不完全な数値は空valueでも未指定にしない。onInputで全削除による復旧も検出する。
                                                    if (e.currentTarget.validity.badInput) {
                                                        updateChannel(i, { tsmfRelTs: Number.NaN });
                                                    } else if (val === "") {
                                                        deleteChannelProperty(i, "tsmfRelTs");
                                                    } else {
                                                        updateChannel(i, { tsmfRelTs: Number(val) });
                                                    }
                                                }}
                                            />
                                        </FormGroup>

                                        <FormGroup label="TsmfGroupId" style={{ width: "100px", marginBottom: 0 }}
                                            intent={isValidTsmfGroupId(ch.tsmfGroupId) ? undefined : "danger"}
                                            helperText={isValidTsmfGroupId(ch.tsmfGroupId) ? undefined : `${i + 1}行目: ${tsmfGroupIdErrorMessage}`}>
                                            <InputGroup
                                                placeholder="Group ID"
                                                type="number" min={1} max={255} step={1}
                                                value={Number.isNaN(ch.tsmfGroupId) ? "" : `${ch.tsmfGroupId ?? ""}`}
                                                onInput={(e) => {
                                                    const val = e.currentTarget.value;
                                                    // 不完全な数値は空valueでも未指定にしない。onInputで全削除による復旧も検出する。
                                                    if (e.currentTarget.validity.badInput) {
                                                        updateChannel(i, { tsmfGroupId: Number.NaN });
                                                    } else if (val === "") {
                                                        deleteChannelProperty(i, "tsmfGroupId");
                                                    } else {
                                                        updateChannel(i, { tsmfGroupId: Number(val) });
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
                                disabled={!hasChanges || hasInvalidRelativeTs || hasInvalidTsmfGroupId}
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
                onClose={closeScanDialog}
                title="Channel Scan"
                style={{ width: "520px" }}
            >
                <DialogBody>
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <FormGroup
                            label="Route"
                            helperText="The type of each channel (GR / BS / CS / SKY / BS4K / CATV) is decided by the network of the services received."
                        >
                            <HTMLSelect
                                value={scanRoute}
                                onChange={(e) => {
                                    scanSourceChosen.current = false;
                                    setScanRoute(e.target.value as ChannelRoute);
                                }}
                                options={channelRoutes.map(route => ({ value: route, label: getChannelRouteLabel(route) }))}
                            />
                        </FormGroup>

                        <FormGroup label="Channels">
                            <HTMLSelect
                                value={scanSource}
                                onChange={(e) => {
                                    scanSourceChosen.current = true;
                                    setScanSource(e.target.value as ChannelScanSource);
                                }}
                                options={[
                                    { value: "preset", label: "Preset of the route" },
                                    { value: "dvbConf", label: "Channel config files of dvbv5 (DVB tuners)" },
                                    { value: "list", label: "List" },
                                    { value: "format", label: "Format" }
                                ]}
                            />
                        </FormGroup>

                        {scanSource === "preset" && (
                            <Callout>
                                {scanRoute === "TER" && "13-62"}
                                {scanRoute === "SAT" && satellitePresetRanges}
                                {scanRoute === "SKY" && "なし (dvbv5 のチャンネル設定ファイルか一覧で指定してください)"}
                                {scanRoute === "CATV" && "1-12, C13-C63, 13-62"}
                                {scanRoute === "FTTH" && `13-62, ${satellitePresetRanges}`}
                            </Callout>
                        )}

                        {scanSource === "list" && (
                            <FormGroup
                                label="Channel List (comma separated)"
                                helperText="範囲指定（14-16、C13-C20、BS01_0-BS01_3）が使えます。重複を含む展開後の件数は4096件までです。指定全体が長い場合は、件数を減らしてください。"
                            >
                                <InputGroup
                                    placeholder="Example: C13-C20,27,BS01_0"
                                    value={scanChannels}
                                    onChange={(e) => setScanChannels(e.target.value)}
                                />
                            </FormGroup>
                        )}

                        {scanSource === "format" && (
                            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <FormGroup
                                    label="Channel Name Format"
                                    helperText="Supports placeholders like {ch}, {ch00}, {subch}."
                                >
                                    <InputGroup
                                        placeholder="Example: C{ch}, BS{ch00}_{subch}"
                                        value={scanChannelNameFormat}
                                        onChange={(e) => setScanChannelNameFormat(e.target.value)}
                                    />
                                </FormGroup>
                                <div style={{ display: "flex", gap: "16px" }}>
                                    <FormGroup label="Min {ch}" style={{ flex: 1 }}>
                                        <InputGroup value={scanMinCh} onChange={(e) => setScanMinCh(e.target.value)} />
                                    </FormGroup>
                                    <FormGroup label="Max {ch}" style={{ flex: 1 }}>
                                        <InputGroup value={scanMaxCh} onChange={(e) => setScanMaxCh(e.target.value)} />
                                    </FormGroup>
                                </div>
                                {/{subch0*}/.test(scanChannelNameFormat) && (
                                    <div style={{ display: "flex", gap: "16px" }}>
                                        <FormGroup label="Min {subch}" style={{ flex: 1 }}>
                                            <InputGroup value={scanMinSubCh} onChange={(e) => setScanMinSubCh(e.target.value)} />
                                        </FormGroup>
                                        <FormGroup label="Max {subch}" style={{ flex: 1 }}>
                                            <InputGroup value={scanMaxSubCh} onChange={(e) => setScanMaxSubCh(e.target.value)} />
                                        </FormGroup>
                                    </div>
                                )}
                            </div>
                        )}

                        <FormGroup
                            label="Skip Channels (comma separated)"
                            helperText="取得を省くチャンネル識別子です。範囲指定（14-16、C13-C20、BS01_0-BS01_3）が使えます。重複を含む展開後の件数は4096件までです。指定全体が長い場合は、件数を減らしてください。"
                        >
                            <InputGroup
                                placeholder="Example: 13,14-16,C18-C20"
                                value={scanSkipCh}
                                onChange={(e) => setScanSkipCh(e.target.value)}
                            />
                        </FormGroup>

                        <div style={{ display: "flex", gap: "16px" }}>
                            <FormGroup label="Scan Mode" style={{ flex: 1 }}>
                                <HTMLSelect
                                    value={scanMode}
                                    onChange={(e) => setScanMode(e.target.value as ChannelScanMode | "")}
                                    options={[
                                        { value: "", label: "Auto (GR: Channel, others: Service)" },
                                        { value: "Channel", label: "Channel" },
                                        { value: "Service", label: "Service" }
                                    ]}
                                />
                            </FormGroup>
                            <FormGroup label="Set Disabled on Add" style={{ flex: 1 }}>
                                <HTMLSelect
                                    value={scanSetDisabledOnAdd}
                                    onChange={(e) => setScanSetDisabledOnAdd(e.target.value as "" | "true" | "false")}
                                    options={[
                                        { value: "", label: "Auto (GR: No, others: Yes)" },
                                        { value: "true", label: "Yes" },
                                        { value: "false", label: "No" }
                                    ]}
                                />
                            </FormGroup>
                        </div>

                        <Switch
                            label="Auto Apply Results (Restart required)"
                            checked={scanAutoApply}
                            onChange={(e) => setScanAutoApply(e.currentTarget.checked)}
                        />

                        <Switch
                            label="Refresh (Update existing channels)"
                            checked={scanRefresh}
                            onChange={(e) => setScanRefresh(e.currentTarget.checked)}
                        />

                        {scanTunersError && !isStartingScan && !scanInProgress && <Callout intent="warning" title="チューナー設定を取得できませんでした">{scanTunersError}</Callout>}
                        {scanError !== null && (
                            <Callout intent="danger" title="Failed to start the scan">{scanError}</Callout>
                        )}
                    </div>
                </DialogBody>
                <DialogFooter
                    actions={
                        <>
                            <Button onClick={closeScanDialog}>Cancel</Button>
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
