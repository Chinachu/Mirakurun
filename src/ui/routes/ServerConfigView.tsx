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
    Dialog,
    DialogBody,
    DialogFooter,
    FormGroup,
    HTMLSelect,
    InputGroup,
    Intent,
    Navbar,
    NonIdealState,
    NumericInput,
    Section,
    Spinner,
    Switch,
    TextArea
} from "@blueprintjs/core";
import equal from "fast-deep-equal";
import { Validator as IPValidator } from "ip-num/Validator";
import { state } from "../modules/state";
import { ConfigServer, LogLevel } from "../../../api.d";

import "./ServerConfigView.sass";

const configAPI = "/api/config/server";

const multilineConfigValue = (values?: string[] | null) => (values ?? []).join("\n");

const parseMultilineConfigValue = (value: string): string[] | null => {
    const trimmedValue = value.trim();
    if (trimmedValue === "") {
        return null;
    }
    return trimmedValue.split("\n").map(line => line.trim());
};

export const ServerConfigView: React.FC = () => {
    console.debug("routes", "ServerConfigView");

    const [current, setCurrent] = useState<ConfigServer | null>(null);
    const [editing, setEditing] = useState<ConfigServer | null>(null);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [saved, setSaved] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [allowIPv4CidrRangesText, setAllowIPv4CidrRangesText] = useState("");
    const [allowIPv6CidrRangesText, setAllowIPv6CidrRangesText] = useState("");
    const [allowOriginsText, setAllowOriginsText] = useState("");

    const syncMultilineConfigValues = (config: ConfigServer) => {
        setAllowIPv4CidrRangesText(multilineConfigValue(config.allowIPv4CidrRanges));
        setAllowIPv6CidrRangesText(multilineConfigValue(config.allowIPv6CidrRanges));
        setAllowOriginsText(multilineConfigValue(config.allowOrigins));
    };

    useEffect(() => {
        if (saved === true) {
            setTimeout(() => {
                // location.reload();
            }, 500);
            setSaved(false);
            return;
        }

        (async () => {
            try {
                const res = await (await fetch(configAPI)).json();
                console.log("ServerConfigView", "GET", configAPI, "->", res);
                setEditing({ ...res });
                setCurrent({ ...res });
                syncMultilineConfigValues(res);
                setIsLoading(false);
            } catch (e) {
                console.error(e);
                setIsLoading(false);
            }
        })();
    }, [saved]);

    const docker = (state as any).status?.process?.env?.DOCKER === "YES";
    const ipv6Ready = docker === false || (state as any).status?.process?.env?.DOCKER_NETWORK === "host";

    let invalid = false;
    let invalidEpgGatheringJobSchedule = false;
    let invalidAllowIPv4CidrRanges = false;
    let invalidAllowIPv6CidrRanges = false;

    if (editing) {
        if (editing.epgGatheringJobSchedule) {
            if (!isValidCronExpression(editing.epgGatheringJobSchedule)) {
                invalid = true;
                invalidEpgGatheringJobSchedule = true;
            }
        }
        if (editing.allowIPv4CidrRanges) {
            for (const range of editing.allowIPv4CidrRanges) {
                const [valid] = IPValidator.isValidIPv4CidrRange(range);
                if (!valid) {
                    invalid = true;
                    invalidAllowIPv4CidrRanges = true;
                    break;
                }
            }
        }
        if (!invalid && editing.allowIPv6CidrRanges) {
            for (const range of editing.allowIPv6CidrRanges) {
                const [valid] = IPValidator.isValidIPv6CidrRange(range);
                if (!valid) {
                    invalid = true;
                    invalidAllowIPv6CidrRanges = true;
                    break;
                }
            }
        }
    }

    const hasChanges = editing !== null && current !== null && !equal(editing, current);

    const handleCancel = () => {
        if (current) {
            setEditing({ ...current });
            syncMultilineConfigValues(current);
        }
    };

    const handleSave = async () => {
        if (!editing) {
            return;
        }

        setShowSaveDialog(false);
        try {
            const payload: { [key: string]: any } = { ...editing };
            for (const key of Object.keys(payload)) {
                if (payload[key] === null) {
                    delete payload[key];
                }
            }
            console.log("ServerConfigView", "PUT", configAPI, "<-", payload);
            await fetch(configAPI, {
                method: "PUT",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify(payload)
            });
            setSaved(true);
        } catch (err) {
            console.error(err);
        }
    };

    const toolbar = (
        <Navbar className="toolbar">
            <Navbar.Group align={Alignment.START}>
                <Navbar.Heading>
                    <Breadcrumbs items={[
                        {
                            text: "サーバー設定"
                        }
                    ]} />
                </Navbar.Heading>
            </Navbar.Group>

            <Navbar.Group align={Alignment.END}>
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
                    disabled={!hasChanges || invalid}
                    onClick={() => setShowSaveDialog(true)}
                />
            </Navbar.Group>
        </Navbar>
    );

    if (isLoading || !editing) {
        return (
            <div className="route" id="route-server-config-view">
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
        <div className="route" id="route-server-config-view">
            {toolbar}

            <div className="content">
                <Section
                    className="config-section"
                    title="Basic Config"
                    icon="settings"
                    compact
                >
                    <div className="config-form-grid">
                        <FormGroup
                            label="Log Level"
                            labelFor="log-level"
                            helperText="ログ出力設定。通常運用では WARN を推奨します。問題が発生した時に変更し、ログを確認してください。"
                        >
                            <HTMLSelect
                                id="log-level"
                                value={editing.logLevel ?? 2}
                                onChange={(e) => {
                                    setEditing({ ...editing, logLevel: parseInt(e.target.value, 10) as LogLevel });
                                }}
                            >
                                <option value="-1">FATAL (-1)</option>
                                <option value="0">ERROR (0)</option>
                                <option value="1">WARN (1)</option>
                                <option value="2">INFO (2)</option>
                                <option value="3">DEBUG (3)</option>
                            </HTMLSelect>
                        </FormGroup>

                        <FormGroup
                            label="Hostname"
                            labelFor="hostname"
                            helperText="Web UI にアクセスするためのホスト名を設定してください。任意のホスト名・ドメイン上のページからのアクセスを禁止しています。 (DNS Rebinding / CSRF 攻撃対策)"
                        >
                            <InputGroup
                                id="hostname"
                                value={editing.hostname ?? ""}
                                onChange={(e) => {
                                    setEditing({ ...editing, hostname: e.target.value });
                                }}
                            />
                        </FormGroup>

                        {ipv6Ready && (
                            <FormGroup
                                className="config-switch-group"
                                labelFor="disable-ipv6"
                                helperText="IPv6 の無効化 (よく分からない場合は ON)"
                            >
                                <Switch
                                    id="disable-ipv6"
                                    checked={editing.disableIPv6 ?? false}
                                    label="Disable IPv6"
                                    onChange={(e) => {
                                        setEditing({ ...editing, disableIPv6: e.currentTarget.checked });
                                    }}
                                />
                            </FormGroup>
                        )}
                    </div>
                </Section>

                <Section
                    className="config-section"
                    title="Advanced Config"
                    icon="wrench"
                    compact
                >
                    <div className="config-form-grid">
                        <FormGroup
                            label="Job Max Running"
                            labelFor="job-max-running"
                            helperText="同時実行できる最大ジョブ数"
                        >
                            <NumericInput
                                id="job-max-running"
                                value={editing.jobMaxRunning ?? ""}
                                placeholder="100"
                                min={1}
                                max={100}
                                onValueChange={(value, _) => {
                                    if (value === null) {
                                        delete editing.jobMaxRunning;
                                    } else {
                                        editing.jobMaxRunning = value;
                                    }
                                    setEditing({ ...editing });
                                }}
                            />
                        </FormGroup>

                        <FormGroup
                            label="Job Max Standby"
                            labelFor="job-max-standby"
                            helperText="同時実行できる最大ジョブ準備数"
                        >
                            <NumericInput
                                id="job-max-standby"
                                value={editing.jobMaxStandby ?? ""}
                                placeholder="100"
                                min={1}
                                max={100}
                                onValueChange={(value, _) => {
                                    if (value === null) {
                                        delete editing.jobMaxStandby;
                                    } else {
                                        editing.jobMaxStandby = value;
                                    }
                                    setEditing({ ...editing });
                                }}
                            />
                        </FormGroup>

                        <FormGroup
                            label="EPG Gathering Job Schedule (Cron)"
                            labelFor="epg-gathering-schedule"
                            helperText={invalidEpgGatheringJobSchedule ? "Cron expression is invalid." : "EPG 収集スケジュール (cron 風形式)"}
                            intent={invalidEpgGatheringJobSchedule ? Intent.DANGER : Intent.NONE}
                        >
                            <InputGroup
                                id="epg-gathering-schedule"
                                value={editing.epgGatheringJobSchedule ?? ""}
                                placeholder="20,50 * * * *"
                                onChange={(e) => {
                                    editing.epgGatheringJobSchedule = e.target.value;
                                    setEditing({ ...editing });
                                }}
                                intent={invalidEpgGatheringJobSchedule ? Intent.DANGER : Intent.NONE}
                            />
                        </FormGroup>

                        <FormGroup
                            label="Max Buffer Bytes Before Ready (MB)"
                            labelFor="max-buffer-bytes"
                            helperText="番組イベント検出前の最大バッファサイズ (バイト) ※番組開始の頭が欠ける場合は増やす"
                        >
                            <NumericInput
                                id="max-buffer-bytes"
                                value={editing.maxBufferBytesBeforeReady ? Math.round(editing.maxBufferBytesBeforeReady / 1024 / 1024) : ""}
                                placeholder="8"
                                min={1}
                                max={64}
                                onValueChange={(value, _) => {
                                    if (value === null) {
                                        delete editing.maxBufferBytesBeforeReady;
                                    } else {
                                        editing.maxBufferBytesBeforeReady = value * 1024 * 1024;
                                    }
                                    setEditing({ ...editing });
                                }}
                            />
                        </FormGroup>

                        <FormGroup
                            label="Event End Timeout (sec)"
                            labelFor="event-end-timeout"
                            helperText="番組イベント終了タイムアウト (ミリ秒) ※番組終了が誤判定される場合は長くする"
                        >
                            <NumericInput
                                id="event-end-timeout"
                                value={editing.eventEndTimeout ?? ""}
                                placeholder="1000"
                                min={1}
                                max={10000}
                                onValueChange={(value, _) => {
                                    if (value === null) {
                                        delete editing.eventEndTimeout;
                                    } else {
                                        editing.eventEndTimeout = value;
                                    }
                                    setEditing({ ...editing });
                                }}
                            />
                        </FormGroup>

                        <FormGroup
                            className="config-switch-group"
                            labelFor="disable-eit-parsing"
                            helperText="EIT 解析の無効化 (EPG 関連機能が無効になります)"
                            intent={editing.disableEITParsing ? Intent.WARNING : Intent.NONE}
                        >
                            <Switch
                                id="disable-eit-parsing"
                                checked={editing.disableEITParsing ?? false}
                                label="Disable EIT Parsing ⚠️"
                                onChange={(e) => {
                                    setEditing({ ...editing, disableEITParsing: e.currentTarget.checked ? true : undefined });
                                }}
                            />
                        </FormGroup>
                    </div>
                </Section>

                <Section
                    className="config-section"
                    title="Network Config"
                    icon="globe-network"
                    compact
                >
                    <div className="config-form-grid">
                        <FormGroup
                            className="config-form-wide"
                            label="Allow IPv4 CIDR Ranges ⚠️"
                            labelFor="allow-ipv4-cidrs"
                            helperText={invalidAllowIPv4CidrRanges ? "IPv4 CIDR range is invalid." : "アクセスを許可する IPv4 CIDR 範囲を1行に1つずつ指定 ⚠️ 最大限の注意が必要な設定です (グローバル IPv4 アドレスを指定しないでください)"}
                            intent={invalidAllowIPv4CidrRanges ? Intent.DANGER : Intent.NONE}
                        >
                            <TextArea
                                id="allow-ipv4-cidrs"
                                value={allowIPv4CidrRangesText}
                                onChange={(e) => {
                                    const newValue = e.target.value;
                                    setAllowIPv4CidrRangesText(newValue);
                                    setEditing({ ...editing, allowIPv4CidrRanges: parseMultilineConfigValue(newValue) });
                                }}
                                rows={3}
                                intent={invalidAllowIPv4CidrRanges ? Intent.DANGER : Intent.NONE}
                            />
                        </FormGroup>

                        <FormGroup
                            className="config-form-wide"
                            label="Allow IPv6 CIDR Ranges ⚠️"
                            labelFor="allow-ipv6-cidrs"
                            helperText={invalidAllowIPv6CidrRanges ? "IPv6 CIDR range is invalid." : "アクセスを許可する IPv6 CIDR 範囲を1行に1つずつ指定 ⚠️ 最大限の注意が必要な設定です (グローバル IPv6 アドレスを指定しないでください)"}
                            intent={invalidAllowIPv6CidrRanges ? Intent.DANGER : Intent.NONE}
                        >
                            <TextArea
                                id="allow-ipv6-cidrs"
                                value={allowIPv6CidrRangesText}
                                onChange={(e) => {
                                    const newValue = e.target.value;
                                    setAllowIPv6CidrRangesText(newValue);
                                    setEditing({ ...editing, allowIPv6CidrRanges: parseMultilineConfigValue(newValue) });
                                }}
                                rows={3}
                                intent={invalidAllowIPv6CidrRanges ? Intent.DANGER : Intent.NONE}
                            />
                        </FormGroup>

                        <FormGroup
                            className="config-form-wide"
                            label="Allow Origins ⚠️🧪"
                            labelFor="allow-origins"
                            helperText="アクセスを許可する Origin を1行に1つずつ指定"
                        >
                            <TextArea
                                id="allow-origins"
                                value={allowOriginsText}
                                onChange={(e) => {
                                    const newValue = e.target.value;
                                    setAllowOriginsText(newValue);
                                    setEditing({ ...editing, allowOrigins: parseMultilineConfigValue(newValue) });
                                }}
                                rows={3}
                            />
                        </FormGroup>

                        <FormGroup
                            className="config-switch-group"
                            labelFor="allow-pna"
                            helperText="Private Network Access / Local Network Access を許可 (ブラウザで保護されたコンテキストからのアクセスを認可できるようになります)"
                        >
                            <Switch
                                id="allow-pna"
                                checked={editing.allowPNA ?? true}
                                label="Allow PNA/LNA 🧪"
                                onChange={(e) => {
                                    setEditing({ ...editing, allowPNA: e.currentTarget.checked });
                                }}
                            />
                        </FormGroup>
                    </div>
                </Section>

                <Section
                    className="config-section"
                    title="Other Config"
                    icon="more"
                    compact
                >
                    <div className="config-form-grid">
                        <FormGroup
                            label="TSPlay Endpoint 🧪"
                            labelFor="tsplay-endpoint"
                            helperText="TSPlay で使用するエンドポイント URL (保護されたコンテキスト)"
                        >
                            <InputGroup
                                id="tsplay-endpoint"
                                value={editing.tsplayEndpoint ?? ""}
                                onChange={(e) => {
                                    const newValue = e.target.value.trim();
                                    if (newValue === "") {
                                        setEditing({ ...editing, tsplayEndpoint: null });
                                    } else {
                                        setEditing({ ...editing, tsplayEndpoint: newValue });
                                    }
                                }}
                            />
                        </FormGroup>
                    </div>
                </Section>
            </div>

            {/* Save Confirmation Dialog */}
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
                                disabled={!hasChanges || invalid}
                                onClick={handleSave}
                            >
                                保存
                            </Button>
                        </>
                    }
                />
            </Dialog>
        </div>
    );
};

// (仮) src/Mirakurun/Job.ts にある関数と同じ
function isValidCronExpression(cronExpression: string): boolean {
    const cronParts = cronExpression.split(" ");
    if (cronParts.length !== 5) {
        return false;
    }
    try {
        // 各部分のパターンを定義
        const patterns = [
            /^(\*|([0-9]|[1-5][0-9])((-[0-9]|[1-5][0-9]))?)(\/([1-9]|[1-5][0-9]))?$/, // 分 (0-59)
            /^(\*|([0-9]|1[0-9]|2[0-3])((-[0-9]|1[0-9]|2[0-3]))?)(\/([1-9]|1[0-9]|2[0-3]))?$/, // 時 (0-23)
            /^(\*|([1-9]|[12][0-9]|3[01])((-[1-9]|[12][0-9]|3[01]))?)(\/([1-9]|[12][0-9]|3[01]))?$/, // 日 (1-31)
            /^(\*|([1-9]|1[0-2])((-[1-9]|1[0-2]))?)(\/([1-9]|1[0-2]))?$/, // 月 (1-12)
            /^(\*|([0-6])((-[0-6]))?)(\/([1-6]))?$/ // 曜日 (0-6)
        ];

        // 各部分を検証
        for (let i = 0; i < 5; i++) {
            // カンマで区切られた値をすべて検証
            const parts = cronParts[i].split(",");
            for (const part of parts) {
                if (part === "" || !patterns[i].test(part)) {
                    return false;
                }
            }
        }
        return true;
    } catch (err) {
        return false;
    }
}
