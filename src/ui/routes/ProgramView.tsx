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
import { useParams } from "react-router-dom";
import { Alignment, Button, Breadcrumbs, Navbar, NonIdealState } from "@blueprintjs/core";
import { DateTime } from "luxon";
import { getGlobalServiceId, getIdWithHex } from "../modules/common";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import * as regexp from "../modules/regexp";
import { clearSchedule, setSchedule } from "../modules/at";
import { Error, Program } from "../../../api.d";

import { ProgramTitle } from "../components/ProgramTitle";
import { WatchButton } from "../components/WatchButton";
import { DateTimeRange } from "../components/DateTimeRange";
import { ServiceLink } from "../components/ServiceLink";
import { ProgramGenres } from "../components/ProgramGenres";
import { ProgramAVInfo } from "../components/ProgramAVInfo";
import { ProgramRelatedLinks } from "../components/ProgramRelatedLinks";

import "./ProgramView.sass";

export const ProgramView: React.FC = () => {
    console.debug("routes", "ProgramView");

    const [reload, setReload] = useState(Date.now()); // リロード用
    const [error, setError] = useState<Error>(null);
    const [program, setProgram] = useState<Program>(null);

    const { navigate } = state;
    const params = useParams();
    const programId = parseInt(params.programId, 10);

    const now = Date.now();
    const startTime = program?.startAt;
    const endTime = program ? program.startAt + program.duration : null;
    const isLoading = program === null && error === null;
    const isOnAir = program && startTime <= now && endTime >= now;
    const date = program && DateTime.fromMillis(program.startAt).set({  hour: 0, minute: 0, second: 0, millisecond: 0 });
    const time = program && DateTime.fromMillis(program.startAt).diff(date).toMillis();
    const timeForServiceLink = (time > (1000 * 60 * 60 * 24 - 1000 * 60 * 5)) ? 1 : time;

    useEffect(() => {
        const onPrograms = (programs: Program[]) => {
            const _program = programs.find(p => p.id === programId);
            if (!_program) {
                setError({
                    code: 404,
                    reason: "番組が見つかりません",
                });
                setProgram(null);
                return;
            }
            setError(null);
            setProgram(_program);
        };
        state.on("programs", onPrograms);
        state.subscribePrograms(true);

        return () => {
            // // unsubscribe せずに差分更新を継続する
            // state.unsubscribePrograms();
            state.off("programs", onPrograms);
        }
    }, [programId]);

    useEffect(() => {
        if (!program) {
            ui.setTitle("番組詳細...", true);
            return;
        }

        ui.setTitle(program.name);

        const schedules: ReturnType<typeof setSchedule>[] = [];
        if (now <= startTime) {
            schedules.push(setSchedule(startTime, () => setReload(Date.now())));
        }
        if (now <= endTime) {
            schedules.push(setSchedule(endTime, () => setReload(Date.now())));
        }

        console.debug("ProgramView", program);

        return () => {
            for (const id of schedules) {
                clearSchedule(id);
            }
        };
    }, [program]);

    return (
        <div className="route" id="route-program-view">
            <Navbar className="toolbar">
                <Navbar.Group align={Alignment.START}>
                    <Navbar.Heading>
                        <Breadcrumbs items={[
                            {
                                text: "EPG",
                                onClick: () => {
                                    navigate(`/epg?date=${date.toISODate()}&time=${time}`)
                                }
                            },
                            {
                                className: isLoading ? "bp5-skeleton" : "",
                                text: isLoading ? "Loading................................." : (error ? "エラー" : (
                                    program ? <ProgramTitle program={program} /> : <></>
                                ))
                            }
                        ]} />
                    </Navbar.Heading>
                </Navbar.Group>

                <Navbar.Group align={Alignment.END}>
                    {isLoading && <>
                        <Button className="bp5-skeleton" text="Loading............................" />
                    </>}

                    {program && <>
                        {isOnAir && <WatchButton variant="outlined" popoverPlacement="bottom-end" globalServiceId={getGlobalServiceId(program.networkId, program.serviceId)} />}
                    </>}

                    <Button
                        variant="outlined"
                        intent="primary"
                        icon="timeline-events"
                        text="番組表で表示"
                        onClick={() => {
                            let to = "/epg";
                            if (program) {
                                to += `?date=${date.toISODate()}`;
                                if (time) {
                                    to += `&time=${time}`;
                                }
                                to += `&programId=${program.id}`;
                            }
                            navigate(to);
                        }}
                    />
                </Navbar.Group>
            </Navbar>

            <div className="content">
                {program && <>
                    <div className="flex">
                        <ServiceLink
                            globalId={getGlobalServiceId(program.networkId, program.serviceId)}
                            date={date.toISODate()}
                            time={timeForServiceLink}
                        />

                        <DateTimeRange start={program.startAt} end={program.startAt + program.duration} />
                    </div>

                    {program.description && (
                        <p className="description">{program.description.replace(regexp.enclosedAttributeUnicode, "")}</p>
                    )}

                    {program.extended && Object.entries(program.extended).map(([head, body]) => {
                        return <div className="extended" key={head}>
                            <h4>{head}</h4>
                            <p dangerouslySetInnerHTML={{ __html: ui.autoLink(body.trim()) }} />
                        </div>;
                    })}

                    {program.genres?.length > 0 && (
                        <ProgramGenres genres={program.genres} />
                    )}

                    {(program.video || program.audios) && (
                        <ProgramAVInfo video={program.video} audios={program.audios} />
                    )}

                    <p className="meta">
                        Program ID: {program.id}<br />
                        event_id: {getIdWithHex(program.eventId)}<br />
                        SID: {getIdWithHex(program.serviceId)}<br />
                        NID: {getIdWithHex(program.networkId)}
                    </p>

                    <ProgramRelatedLinks program={program} />
                </>}

                {error && <>
                    <NonIdealState
                        icon="warning-sign"
                        title={`${error.code} Error`}
                        description={error.reason || "エラーが発生しました"}
                    />
                </>}
            </div>
        </div>
    );
};
