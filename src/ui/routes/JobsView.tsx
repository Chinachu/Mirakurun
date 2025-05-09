import * as React from "react";
import { useState, useEffect } from "react";
import { Alignment, Spinner, Breadcrumbs, Navbar, NonIdealState, NonIdealStateProps, Card, Section } from "@blueprintjs/core";
import { DateTime } from "luxon";
import { useLocalStorageState } from "../hooks/useWebStorageState";
import { LazyCaller } from "../modules/common";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import { JobScheduleItem, JobItem } from "../../../api.d";

// import "./JobsView.sass";

export const JobsView: React.FC = () => {
    console.debug("routes", "JobsView");

    const [nonIdealState, setNonIdealState] = useState<NonIdealStateProps>(null);
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

    const { navigate } = state;

    const isLoading = !state.jobs && !state.jobSchedules;
    ui.setTitle(title, isLoading);

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

        setJobScheduleItems(state.jobSchedules.map(jobSchedule => createJobScheduleItem(jobSchedule)));

        setQueuedJobItems(state.jobs.filter(job => job.status === "queued").map(job => createJobItem(job)));
        setStandbyJobItems(state.jobs.filter(job => job.status === "standby").map(job => createJobItem(job)));
        setRunningJobItems(state.jobs.filter(job => job.status === "running").map(job => createJobItem(job)));
        setFinishedJobItems(state.jobs.filter(job => job.status === "finished").map(job => createJobItem(job)));

        setNonIdealState(null);

        return () => {
            setNonIdealState(null);
        };
    }, [reload]);

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
        </div>
    );
};

function createJobScheduleItem(jobSchedule: JobScheduleItem) {
    return (
        <Card key={jobSchedule.key}>
        </Card>
    );
}

function createJobItem(job: JobItem) {
    return (
        <Card key={job.id}>
        </Card>
    );
}
