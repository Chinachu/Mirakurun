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
import { useState, useEffect, useMemo } from "react";
import {
    Stack,
    Separator,
    Icon,
    Text,
    DetailsList,
    IColumn,
    IGroup,
    Dialog,
    DialogFooter,
    DialogType,
    PrimaryButton,
    DefaultButton,
    IconButton,
} from "@fluentui/react";
import { Client as RPCClient } from "jsonrpc2-ws";
import { Event, JobItem, JobScheduleItem } from "../../../api";
// import "./Jobs.css";

const jobStatusOrderMap = {
    queued: 0,
    standby: 1,
    running: 2,
    finished: 3
};

const scheduleColumns: IColumn[] = [
    {
        key: "col-schedule",
        fieldName: "schedule",
        name: "Schedule",
        minWidth: 140,
        maxWidth: 140
    },
    {
        key: "col-name",
        fieldName: "name",
        name: "Name",
        minWidth: 0,
        flexGrow: 1
    },
    {
        key: "col-actions",
        fieldName: "actions",
        name: "Actions",
        minWidth: 50,
        maxWidth: 50
    }
];

const jobColumns: IColumn[] = [
    {
        key: "col-id",
        fieldName: "id",
        name: "ID",
        minWidth: 140,
        maxWidth: 140
    },
    {
        key: "col-name",
        fieldName: "name",
        name: "Name",
        minWidth: 0,
        flexGrow: 1
    },
    {
        key: "col-status",
        fieldName: "status",
        name: "Status",
        minWidth: 200,
        maxWidth: 200
    },
    {
        key: "col-timestamp",
        fieldName: "timestamp",
        name: "Timestamp",
        minWidth: 130,
        maxWidth: 130
    },
    {
        key: "col-actions",
        fieldName: "actions",
        name: "Actions",
        minWidth: 50,
        maxWidth: 50
    }
];

const jobs: JobItem[] = [];
const schedules: JobScheduleItem[] = [];

const JobsView: React.FC<{ uiStateEvents: EventEmitter, rpc: RPCClient }> = ({ uiStateEvents, rpc }) => {
    const [updated, setUpdated] = useState<number>(0);
    const [confirmToRunSchedule, setConfirmToRunSchedule] = useState<JobScheduleItem | null>(null);
    const [confirmToAbortJob, setConfirmToAbortJob] = useState<JobItem | null>(null);

    useEffect(() => {
        const load = async () => {
            schedules.splice(0, schedules.length, ...await (await fetch("/api/job-schedules")).json());
            jobs.splice(0, jobs.length, ...await (await fetch("/api/jobs")).json());
            setUpdated(Date.now());
        };

        load();
        rpc.on("connected", load);

        // 謎の初期レイアウト崩れを修正するためのタイマー
        const fixLayoutTimer = setTimeout(() => setUpdated(Date.now()), 1000);

        return () => {
            clearTimeout(fixLayoutTimer);
            rpc.off("connected", load);
        };
    }, []);

    useEffect(() => {
        const onEvents = (events: Event[]) => {
            let update = false;
            for (const event of events) {
                if (event.resource !== "job" && event.resource !== "job_schedule") {
                    continue;
                }
                update = true;

                if (event.resource === "job") {
                    const job = event.data as JobItem;

                    const index = jobs.findIndex(j => j.id === job.id);
                    if (index === -1) {
                        jobs.push(job);
                    } else {
                        jobs.splice(index, 1, job);
                    }

                    jobs.sort((a, b) => {
                        if (a.status === b.status) {
                            if (a.finishedAt && b.finishedAt) {
                                return b.finishedAt - a.finishedAt;
                            }
                            if (a.startedAt && b.startedAt) {
                                return b.startedAt - a.startedAt;
                            }
                            if (a.createdAt && b.createdAt) {
                                return b.createdAt - a.createdAt;
                            }
                            return b.id.localeCompare(a.id);
                        }
                        return jobStatusOrderMap[a.status] - jobStatusOrderMap[b.status];
                    });

                    continue;
                }

                if (event.resource === "job_schedule") {
                    const schedule = event.data as JobScheduleItem;

                    const index = schedules.findIndex(s => s.key === schedule.key);
                    if (index === -1) {
                        schedules.push(schedule);
                    } else {
                        schedules.splice(index, 1, schedule);
                    }

                    schedules.sort((a, b) => {
                        if (a.job.name === b.job.name) {
                            return a.key.localeCompare(b.key);
                        }
                        return a.job.name.localeCompare(b.job.name);
                    });

                    continue;
                }
            }

            if (update) {
                setUpdated(Date.now());
            }
        };

        uiStateEvents.on("data:events", onEvents);
        return () => {
            uiStateEvents.off("data:events", onEvents);
        };
    }, []);

    // スケジュールカスタムレンダリング
    const onRenderItemColumnForSchedules = useMemo(() => (item: JobScheduleItem, index?: number, column?: IColumn) => {
        if (!column) return null;

        switch (column.key) {
            case "col-schedule":
                return <Text style={{ lineHeight: "30px", marginLeft: 8 }}>{item.schedule}</Text>;
            case "col-name":
                return <Text title={item.key} style={{ lineHeight: "30px", marginLeft: 8 }}>{item.job.name}</Text>;
            case "col-actions":
                return <IconButton
                    title="Run..."
                    iconProps={{ iconName: "Play" }}
                    onClick={() => setConfirmToRunSchedule(item)}
                />;
            default:
                return null;
        }
    }, [updated]);

    const scheduleList = useMemo(() => {
        // スケジュールをグループ化
        const groupMap: Record<string, JobScheduleItem[]> = {};

        schedules.forEach(schedule => {
            const groupKey = schedule.key.split(".")[0];
            if (!groupMap[groupKey]) {
                groupMap[groupKey] = [];
            }
            groupMap[groupKey].push(schedule);
        });

        // グループの作成
        const groups: IGroup[] = [];
        let startIndex = 0;

        Object.entries(groupMap).forEach(([groupKey, items]) => {
            groups.push({
                key: `schedule-group-${groupKey}`, // ユニークなプレフィックスを追加
                name: groupKey,
                startIndex: startIndex,
                isCollapsed: (groupKey !== "EPG"),
                count: items.length
            });
            startIndex += items.length;
        });

        return (
            <DetailsList
                items={schedules}
                groups={groups}
                columns={scheduleColumns}
                isHeaderVisible={false}
                onRenderItemColumn={onRenderItemColumnForSchedules}
                selectionMode={0}
                getKey={(item: JobScheduleItem) => `${item.key}-${item.job.key}`}
                compact
            />
        );
    }, [updated]);

    // ジョブアイテムのレンダリング
    const onRenderItemColumnForJobs = useMemo(() => (job: JobItem, index?: number, column?: IColumn) => {
        if (!column) return null;

        let resultIcon = "Recent";
        let resultText = "Queued...";
        let resultColor = "#a098e5";
        if (job.status === "standby") {
            resultIcon = "ReminderTime";
            resultColor = "#e6b422";
            resultText = "Standby...";
        } else if (job.status === "running") {
            resultIcon = "ProgressRingDots";
            resultColor = "#2ca9e1";
            resultText = "Running...";
        } else if (job.status === "finished") {
            if (job.hasSkipped) {
                resultIcon = "LocationCircle";
                resultColor = "#949495";
                resultText = "Skipped";
            } else if (job.hasAborted) {
                resultIcon = "Clear";
                resultColor = "#f6ad49";
                resultText = "Aborted";
            } else if (job.hasFailed) {
                resultIcon = "Error";
                resultColor = "#e95464";
                resultText = "Failed";
            } else {
                resultIcon = "CheckMark";
                resultColor = "#c3d825";
                resultText = "Finished";
            }

            if (job.duration) {
                resultText += ` (${Math.round(job.duration / 1000)}s)`;
            }
        }

        if (job.retryCount > 0) {
            resultText += ` ⚠️Retry=${job.retryCount}`;
        }

        switch (column.key) {
            case "col-id":
                return <Text style={{ lineHeight: "30px" }}>{job.id}</Text>;
            case "col-name":
                return <Text title={job.key} style={{ lineHeight: "30px" }}>{job.name}</Text>;
            case "col-status":
                return <>
                    <Icon iconName={resultIcon} style={{ color: resultColor }} />
                    <Text style={{ lineHeight: "30px", marginLeft: 8 }}>{resultText}</Text>
                </>;
            case "col-timestamp":
                return <Text style={{ lineHeight: "30px" }}>{new Date(job.updatedAt).toLocaleString()}</Text>;
            case "col-actions":
                return job.status !== "finished" && !job.isAborting ? (
                    <IconButton
                        title="Abort..."
                        iconProps={{ iconName: "Cancel" }}
                        onClick={() => setConfirmToAbortJob(job)}
                    />
                ) : <></>;
            default:
                return null;
        }
    }, [updated]);

    const jobList = useMemo(() => {
        // ジョブをグループ化
        const groupMap: Record<string, JobItem[]> = {};

        jobs.forEach(job => {
            const groupKey = job.status;
            if (!groupMap[groupKey]) {
                groupMap[groupKey] = [];
            }
            groupMap[groupKey].push(job);
        });

        // グループの作成
        const groups: IGroup[] = [];
        let startIndex = 0;

        Object.entries(groupMap).forEach(([groupKey, items]) => {
            groups.push({
                key: `job-group-${groupKey}`, // ユニークなプレフィックスを追加
                name: groupKey,
                startIndex: startIndex,
                isCollapsed: false,
                count: items.length
            });
            startIndex += items.length;
        });

        return (
            <DetailsList
                items={jobs}
                groups={groups}
                columns={jobColumns}
                isHeaderVisible={false}
                onRenderItemColumn={onRenderItemColumnForJobs}
                selectionMode={0}
                getKey={(item: JobItem) => item.id}
                compact
            />
        );
    }, [updated]);

    return <>
        <Stack tokens={{ childrenGap: "16 0" }} style={{ margin: "16px 0 8px" }}>
            <Stack>
                <Separator alignContent="start">Schedules</Separator>
                <div className="ms-Grid" dir="ltr">
                    <div className="ms-Grid-row">
                        {scheduleList}
                    </div>
                </div>
            </Stack>
            <Stack>
                <Separator alignContent="start">Jobs</Separator>
                <div className="ms-Grid" dir="ltr" style={{ marginLeft: 8 }}>
                    <div className="ms-Grid-row">
                        {jobList}
                    </div>
                </div>
            </Stack>
        </Stack>

        <Dialog
            hidden={!confirmToRunSchedule}
            onDismiss={() => setConfirmToRunSchedule(null)}
            dialogContentProps={{
                type: DialogType.largeHeader,
                title: "Run Schedule",
                subText: "Do you want to run the scheduled job immediately? If it is already running, nothing will happen."
            }}
        >
            <DialogFooter>
                <PrimaryButton
                    text="Add"
                    onClick={() => {
                        (async () => {
                            await fetch(`/api/job-schedules/${confirmToRunSchedule.key}/run`, { method: "PUT" });
                        })();
                        setConfirmToRunSchedule(null);
                    }}
                />
                <DefaultButton
                    text="Cancel"
                    onClick={() => setConfirmToRunSchedule(null)}
                />
            </DialogFooter>
        </Dialog>

        <Dialog
            hidden={!confirmToAbortJob}
            onDismiss={() => setConfirmToAbortJob(null)}
            dialogContentProps={{
                type: DialogType.largeHeader,
                title: "Abort Job",
                subText: "Would you like to request a abort?"
            }}
        >
            <DialogFooter>
                <PrimaryButton
                    text="Abort"
                    onClick={() => {
                        (async () => {
                            await fetch(`/api/jobs/${confirmToAbortJob.id}/abort`, { method: "PUT" });
                        })();
                        setConfirmToAbortJob(null);
                    }}
                />
                <DefaultButton
                    text="Cancel"
                    onClick={() => setConfirmToAbortJob(null)}
                />
            </DialogFooter>
        </Dialog>
    </>;
};

export default JobsView;
