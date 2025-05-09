import * as React from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@blueprintjs/core";
import { DateTime } from "luxon";
import { getGlobalServiceId } from "../modules/common";
import { setSchedule, clearSchedule } from "../modules/at";
import * as regexp from "../modules/regexp";
import { Program } from "../../../api.d";

import { ServiceLink } from "./ServiceLink";
import { ProgramTitle } from "./ProgramTitle";
import { DateTimeRange } from "./DateTimeRange";
import { ProgramGenres } from "./ProgramGenres";
import { ProgramAVInfo } from "./ProgramAVInfo";
import { WatchButton } from "./WatchButton";

import "./ProgramCardBase.sass";

type ProgramCardBaseProps = {
    program: Program;
    noAVInfo?: boolean;
    noActions?: boolean;
} & React.HTMLAttributes<HTMLDivElement>;
export const ProgramCardBase: React.FC<ProgramCardBaseProps> = ({ program, noAVInfo, noActions, ...props }) => {
    console.debug("components", "ProgramCardBase", program);

    const now = Date.now();
    const endAt = program.startAt + program.duration;
    const isDummy = !Number.isInteger(program.id);
    const date = DateTime.fromMillis(program.startAt).set({  hour: 0, minute: 0, second: 0, millisecond: 0 });
    const time = DateTime.fromMillis(program.startAt).diff(date).toMillis();
    const timeForServiceLink = (time > (1000 * 60 * 60 * 24 - 1000 * 60 * 5)) ? 1 : time;

    const [isOnAir, setIsOnAir] = useState(!isDummy && program.startAt <= now && endAt >= now);

    useEffect(() => {
        if (isDummy || noActions) {
            return;
        }

        const schedules: ReturnType<typeof setSchedule>[] = [];
        if (now <= program.startAt) {
            schedules.push(setSchedule(program.startAt, () => setIsOnAir(true)));
        }
        if (now <= endAt) {
            schedules.push(setSchedule(endAt, () => setIsOnAir(false)));
        }

        return () => {
            for (const id of schedules) {
                clearSchedule(id);
            }
        };
    }, [program]);

    return (
        <div className="component-program-card-base" {...props}>
            <ServiceLink
                globalId={getGlobalServiceId(program.networkId, program.serviceId)}
                date={date.toISODate()}
                time={timeForServiceLink}
            />

            <p className="title">
                {noActions && (
                    <Link to={`/epg/programs/${program.id}`}>
                        <ProgramTitle program={program} />
                    </Link>
                )}
                {!noActions && (
                    <ProgramTitle program={program} />
                )}
            </p>

            <p className="datetime">
                <DateTimeRange start={program.startAt} end={endAt} />
            </p>

            {program.description && <p className="description">{program.description.replace(regexp.enclosedAttributeUnicode, "")}</p>}

            {program.genres?.length > 0 && (
                <ProgramGenres genres={program.genres} />
            )}

            {!noAVInfo && (program.video || program.audios) && (
                <ProgramAVInfo video={program.video} audios={program.audios} />
            )}

            {!noActions && !isDummy && (
                <div className="actions">
                    <div>
                        <Link className="more" to={`/epg/programs/${program.id}`}>
                            <Button variant="outlined" intent="primary" icon="arrow-right" text="番組詳細" />
                        </Link>

                        {(isOnAir) && (
                            <WatchButton variant="outlined" popoverPlacement="top-start" globalServiceId={getGlobalServiceId(program.networkId, program.serviceId)} />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
