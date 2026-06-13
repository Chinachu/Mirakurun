import * as React from "react";
import { useState, useEffect } from "react";
import { Alignment, Spinner, Breadcrumbs, Navbar, NonIdealState, NonIdealStateProps, Section, Button, Dialog, DialogBody, DialogFooter, Tooltip, Icon } from "@blueprintjs/core";
import { DateTime } from "luxon";
import { useLocalStorageState } from "../hooks/useWebStorageState";
import { LazyCaller } from "../modules/common";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import { JobScheduleItem, JobItem, Error as ApiError } from "../../../api.d";

import "./JobsView.sass";

export const JobsView: React.FC = () => {
    console.debug("routes", "JobsView");

    const [nonIdealState, setNonIdealState] = useState<NonIdealStateProps | null>(null);
    const [reload, setReload] = useState<number>(0);
    const [jobScheduleIsOpen, setJobScheduleIsOpen] = useLocalStorageState<boolean>("JobsView.jobScheduleIsOpen", true);
    const [queuedIsOpen, setQueuedIsOpen] = useLocalStorageState<boolean>("JobsView.queuedIsOpen", true);
    const [standbyIsOpen, setStandbyIsOpen] = useLocalStorageState<boolean>("JobsView.standbyIsOpen", true);
    const [runningIsOpen, setRunningIsOpen] = useLocalStorageState<boolean>("JobsView.runningIsOpen", true);
    const [finishedIsOpen, setFinishedIsOpen] = useLocalStorageState<boolean>("JobsView.finishedIsOpen", true);
    const [jobScheduleItems, setJobScheduleItems] = useState<JSX.Element[]>([]);
    const [queuedJobItems, setQueuedJobItems] = useState<JSX.Element[]>([]);
    const [standbyJobItems, setStandbyJobItems] = useState<JSX.Element[]>([]);
    const [runningJobItems, setRunningJobItems] = useState<JSX.Element[]>([]);
    const [finishedJobItems, setFinishedJobItems] = useState<JSX.Element[]>([]);
    const [title, setTitle] = useState<string>("ジョブ");
    // const isLoading = !programs && !error;

    // Action dialog state
    const [isDialogOpen, setIsDialogOpen] = useState<boolean>(false);
    const [dialogType, setDialogType] = useState<"run_schedule" | "abort_job" | "rerun_job" | null>(null);
    const [selectedScheduleKey, setSelectedScheduleKey] = useState<string | null>(null);
    const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
    const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const isLoading = !state.jobs && !state.jobSchedules;
    ui.setTitle(title, isLoading);

    // API handlers for job operations
    const runJobSchedule = async (key: string): Promise<boolean> => {
        try {
            const res = await fetch(`/api/job-schedules/${encodeURIComponent(key)}/run`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
            });

            if (!res.ok) {
                const errorData = await res.json() as ApiError;
                setActionError(errorData.reason || `Error: ${res.status}`);
                return false;
            }

            // Re-fetch jobs and job schedules
            await state.fetchJobs();
            await state.fetchJobSchedules();
            setActionError(null);
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setActionError(`リクエスト失敗: ${message}`);
            return false;
        }
    };

    const abortJob = async (jobId: string): Promise<boolean> => {
        try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/abort`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
            });

            if (!res.ok) {
                const errorData = await res.json() as ApiError;
                setActionError(errorData.reason || `Error: ${res.status}`);
                return false;
            }

            // Re-fetch jobs
            await state.fetchJobs();
            setActionError(null);
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setActionError(`リクエスト失敗: ${message}`);
            return false;
        }
    };

    const rerunJob = async (jobId: string): Promise<boolean> => {
        try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/rerun`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
            });

            if (!res.ok) {
                const errorData = await res.json() as ApiError;
                setActionError(errorData.reason || `Error: ${res.status}`);
                return false;
            }

            // Re-fetch jobs
            await state.fetchJobs();
            setActionError(null);
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setActionError(`リクエスト失敗: ${message}`);
            return false;
        }
    };

    // Dialog action handler
    const handleConfirm = async () => {
        setIsActionLoading(true);
        let success = false;

        try {
            if (dialogType === "run_schedule" && selectedScheduleKey) {
                success = await runJobSchedule(selectedScheduleKey);
            } else if (dialogType === "abort_job" && selectedJobId) {
                success = await abortJob(selectedJobId);
            } else if (dialogType === "rerun_job" && selectedJobId) {
                success = await rerunJob(selectedJobId);
            }

            if (success) {
                setIsDialogOpen(false);
                setDialogType(null);
                setSelectedScheduleKey(null);
                setSelectedJobId(null);
            }
        } finally {
            setIsActionLoading(false);
        }
    };

    const openDialog = (type: "run_schedule" | "abort_job" | "rerun_job", key?: string) => {
        setActionError(null);
        setDialogType(type);

        if (type === "run_schedule" && key) {
            setSelectedScheduleKey(key);
        } else if (type !== "run_schedule" && key) {
            setSelectedJobId(key);
        }

        setIsDialogOpen(true);
    };

    useEffect(() => {
        const onUpdated = () => {
            setReload(Date.now());
        };
        const onUpdatedLazy = new LazyCaller(0, 500, onUpdated);
        state.on("jobs", onUpdatedLazy.caller);
        state.on("jobSchedules", onUpdatedLazy.caller);

        return () => {
            state.off("jobs", onUpdatedLazy.caller);
            state.off("jobSchedules", onUpdatedLazy.caller);
            onUpdatedLazy.destroy();
        }
    }, []);

    useEffect(() => {
        if (isLoading) {
            setTitle("ジョブ...");
            setNonIdealState({
                icon: <Spinner />,
                title: "ロード中",
                description: "ジョブを読み込んでいます..."
            });
            return;
        }

        setJobScheduleItems(state.jobSchedules.map(jobSchedule => createJobScheduleItemElement(jobSchedule)));

        setQueuedJobItems(state.jobs.filter(job => job.status === "queued").map(job => createJobItemElement(job)));
        setStandbyJobItems(state.jobs.filter(job => job.status === "standby").map(job => createJobItemElement(job)));
        setRunningJobItems(state.jobs.filter(job => job.status === "running").map(job => createJobItemElement(job)));
        setFinishedJobItems(state.jobs.filter(job => job.status === "finished").map(job => createJobItemElement(job)));

        setNonIdealState(null);

        return () => {
            setNonIdealState(null);
        };
    }, [reload]);

    // Helper functions to create job/schedule items with closures over openDialog
    const createJobScheduleItemElement = (jobSchedule: JobScheduleItem) => {
        return (
            <Navbar key={jobSchedule.key}>
                <Navbar.Group align={Alignment.START}>
                    <code className="bp5-code">
                        {jobSchedule.schedule}
                    </code>
                    <span>
                        {jobSchedule.job.name}
                    </span>
                </Navbar.Group>

                <Navbar.Group align={Alignment.END}>
                    <Button
                        variant="minimal"
                        intent="warning"
                        icon="play"
                        text="実行..."
                        onClick={() => openDialog("run_schedule", jobSchedule.key)}
                    />
                </Navbar.Group>
            </Navbar>
        );
    };

    const createJobItemElement = (job: JobItem) => {
        const statusLabel = getJobStatusLabel(job);
        const statusIcon = getJobStatusIcon(job);
        const statusIntent = getJobStatusIntent(job);

        // Build detail tooltip content
        const detailLines: string[] = [
            `ID: ${job.id}`,
            `Key: ${job.key}`
        ];

        if (job.retryMax) {
            detailLines.push(`リトライ: ${job.retryCount}/${job.retryMax}`);
        }

        if (job.startedAt) {
            detailLines.push(`開始: ${DateTime.fromMillis(job.startedAt).toFormat("yyyy/MM/dd HH:mm:ss")}`);
        }

        if (job.finishedAt) {
            detailLines.push(`終了: ${DateTime.fromMillis(job.finishedAt).toFormat("yyyy/MM/dd HH:mm:ss")}`);
        }

        if (job.duration) {
            const durationSec = Math.round(job.duration / 1000);
            detailLines.push(`実行時間: ${durationSec}秒`);
        }

        if (job.hasFailed && job.error) {
            detailLines.push(`エラー: ${job.error}`);
        }

        if (job.hasAborted) {
            detailLines.push("状態: 中止済み");
        }

        if (job.hasSkipped) {
            detailLines.push("状態: スキップ");
        }

        const detailTooltip = detailLines.join("\n");

        return (
            <Navbar key={job.id}>
                <Navbar.Group align={Alignment.START}>
                    <Tooltip content={detailTooltip} position="right">
                        <span className="bp5-text-muted" style={{ cursor: "help" }} title="詳細">
                            {job.id.split(".").slice(-1)[0]}
                        </span>
                    </Tooltip>
                    <span title={job.key} style={{ marginLeft: "0.5rem" }}>
                        {job.name}
                    </span>
                </Navbar.Group>

                <Navbar.Group align={Alignment.END}>
                    <span className="bp5-text-muted" style={{ marginLeft: "0.5rem" }}>
                        <Icon icon={statusIcon} intent={statusIntent} />
                        <span style={{ marginLeft: "0.35rem" }}>{statusLabel}</span>
                    </span>

                    <Tooltip content={DateTime.fromMillis(job.updatedAt).toFormat("yyyy/MM/dd HH:mm:ss")}>
                        <span className="bp5-text-muted">
                            {DateTime.fromMillis(job.updatedAt).toRelativeCalendar()}
                        </span>
                    </Tooltip>

                    {job.status !== "finished" && (
                        <Button
                            minimal
                            small
                            icon="stop"
                            intent="danger"
                            onClick={() => openDialog("abort_job", job.id)}
                            title="ジョブを中止リクエスト"
                            disabled={job.isAborting}
                        />
                    )}

                    {job.status === "finished" && job.isRerunnable && (
                        <Button
                            minimal
                            small
                            icon="refresh"
                            intent="primary"
                            onClick={() => openDialog("rerun_job", job.id)}
                            title="ジョブを再実行"
                        />
                    )}
                </Navbar.Group>
            </Navbar>
        );
    };

    return (
        <div className="route" id="route-jobs-view">
            <Navbar className="toolbar">
                <Navbar.Group align={Alignment.START}>
                    <Navbar.Heading>
                        <Breadcrumbs items={[
                            {
                                text: "ジョブ"
                            }
                        ]} />
                    </Navbar.Heading>
                </Navbar.Group>

                <Navbar.Group align={Alignment.END}>
                </Navbar.Group>
            </Navbar>

            <div className="content">
                {!nonIdealState && <>
                    <Section
                        title="スケジュール"
                        icon="time"
                        collapsible
                        collapseProps={{
                            isOpen: jobScheduleIsOpen,
                            onToggle: () => setJobScheduleIsOpen(!jobScheduleIsOpen),
                        }}
                        compact
                    >
                        {jobScheduleItems.map((item) => item)}
                    </Section>

                    <Section
                        title="ジョブ"
                        icon="ninja"
                        collapsible
                        compact
                    >
                        {queuedJobItems.length > 0 && (
                            <Section
                                title={`queued (${queuedJobItems.length})`}
                                icon="time"
                                collapsible
                                collapseProps={{
                                    isOpen: queuedIsOpen,
                                    onToggle: () => setQueuedIsOpen(!queuedIsOpen),
                                }}
                                compact
                            >
                                {queuedJobItems.map((item) => item)}
                            </Section>
                        )}

                        {standbyJobItems.length > 0 && (
                            <Section
                                title={`standby (${standbyJobItems.length})`}
                                icon="stopwatch"
                                collapsible
                                collapseProps={{
                                    isOpen: standbyIsOpen,
                                    onToggle: () => setStandbyIsOpen(!standbyIsOpen),
                                }}
                                compact
                            >
                                {standbyJobItems.map((item) => item)}
                            </Section>
                        )}

                        {runningJobItems.length > 0 && (
                            <Section
                                title={`running (${runningJobItems.length})`}
                                icon="play"
                                collapsible
                                collapseProps={{
                                    isOpen: runningIsOpen,
                                    onToggle: () => setRunningIsOpen(!runningIsOpen),
                                }}
                                compact
                            >
                                {runningJobItems.map((item) => item)}
                            </Section>
                        )}

                        {finishedJobItems.length > 0 && (
                            <Section
                                title={`finished (${finishedJobItems.length})`}
                                icon="tick"
                                collapsible
                                collapseProps={{
                                    isOpen: finishedIsOpen,
                                    onToggle: () => setFinishedIsOpen(!finishedIsOpen),
                                }}
                                compact
                            >
                                {finishedJobItems.map((item) => item)}
                            </Section>
                        )}
                    </Section>
                </>}

                {nonIdealState && <>
                    <NonIdealState {...nonIdealState} />
                </>}
            </div>

            {/* Confirmation Dialog */}
            <Dialog
                isOpen={isDialogOpen}
                onClose={() => setIsDialogOpen(false)}
                title={
                    dialogType === "run_schedule" ? "スケジュール実行" :
                    dialogType === "abort_job" ? "ジョブ中止" :
                    dialogType === "rerun_job" ? "ジョブ再実行" :
                    "確認"
                }
                canEscapeKeyClose={!isActionLoading}
            >
                <DialogBody>
                    {actionError && (
                        <div className="bp5-text-intent-danger" style={{ marginBottom: "16px" }}>
                            {actionError}
                        </div>
                    )}
                    <div>
                        {dialogType === "run_schedule" && "このスケジュールのジョブを実行してもよろしいですか？"}
                        {dialogType === "abort_job" && "このジョブの中止をリクエストしてもよろしいですか？"}
                        {dialogType === "rerun_job" && "このジョブを再実行してもよろしいですか？"}
                    </div>
                </DialogBody>
                <DialogFooter
                    actions={
                        <>
                            <Button text="キャンセル" onClick={() => setIsDialogOpen(false)} disabled={isActionLoading} />
                            <Button text="実行" intent="primary" onClick={handleConfirm} loading={isActionLoading} />
                        </>
                    }
                />
            </Dialog>
        </div>
    );
};

function getJobStatusLabel(job: JobItem): string {
    if (job.status === "queued") {
        return "Queued...";
    }
    if (job.status === "standby") {
        return "Standby...";
    }
    if (job.status === "running") {
        return "Running...";
    }
    if (job.hasFailed) {
        return `Failed${job.duration ? ` (${Math.round(job.duration / 1000)}s)` : ""}`;
    }
    if (job.hasAborted) {
        return "Aborted";
    }
    if (job.hasSkipped) {
        return "Skipped";
    }
    return `Finished${job.duration ? ` (${Math.round(job.duration / 1000)}s)` : ""}`;
}

function getJobStatusIcon(job: JobItem): any {
    if (job.status === "queued") return "time";
    if (job.status === "standby") return "stopwatch";
    if (job.status === "running") return "play";
    if (job.hasFailed) return "error";
    if (job.hasAborted) return "cross";
    if (job.hasSkipped) return "disable";
    return "tick";
}

function getJobStatusIntent(job: JobItem): "none" | "primary" | "success" | "warning" | "danger" {
    if (job.status === "running") return "primary";
    if (job.status === "standby") return "warning";
    if (job.hasFailed) return "danger";
    if (job.hasAborted) return "warning";
    return "success";
}
