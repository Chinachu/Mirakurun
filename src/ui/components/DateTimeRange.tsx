import * as React from "react";
import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { inRange } from "../modules/common";
import { clearSchedule, setSchedule } from "../modules/at";

import "./DateTimeRange.sass";

type DateTimeRangeProps = {
    start: number;
    end?: number;
};
export const DateTimeRange: React.FC<DateTimeRangeProps> = ({ start, end }) => {
    console.debug("components", "DateTimeRange");

    const [update, setUpdate] = useState(0);

    const nowDate = DateTime.now();
    const startDate = DateTime.fromMillis(start);
    const endDate = end ? DateTime.fromMillis(end) : undefined;
    const durationS = endDate ? endDate.diff(startDate, "seconds").seconds : 0;
    const deltaS = nowDate.diff(startDate, "seconds").seconds;
    const progress = end && inRange(nowDate, startDate, endDate) ? deltaS / durationS : undefined;
    const relative = progress ? "放送中" : `@${startDate.toRelative({ style: "narrow" })}`;

    useEffect(() => {
        const schedules: ReturnType<typeof setSchedule>[] = [];
        if (nowDate <= startDate) {
            schedules.push(setSchedule(startDate.toMillis(), () => setUpdate(Date.now())));
        }
        if (nowDate <= endDate) {
            schedules.push(setSchedule(endDate.toMillis(), () => setUpdate(Date.now())));
        }

        return () => {
            for (const id of schedules) {
                clearSchedule(id);
            }
        };
    }, [start, end]);

    useEffect(() => {
        let ms = 10000;
        if (!progress) {
            const diff = Math.abs(deltaS);
            if (diff < 15) {
                ms = 1000;
            } else if (diff < 30) {
                ms = 5000;
            } else if (diff < 60) {
                ms = 10000;
            } else if (diff < 60 * 2) {
                ms = 20000;
            } else if (diff < 60 * 5) {
                ms = 30000;
            } else if (diff < 60 * 60) {
                ms = 60000;
            } else {
                ms = 180000;
            }
        }

        const timeoutId = setTimeout(() => setUpdate(Date.now()), ms);

        return () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        };
    }, [update]);

    return (
        <span className="component-date-time-range" title={startDate.toISO()}>
            {startDate.toFormat("M/d (ccc) HH:mm")}
            &nbsp;–&nbsp;
            {end && <>
                {endDate.toFormat("HH:mm")}
                &nbsp;({durationS / 60}分間)
            </>}
            &nbsp;
            <span className="relative">{relative}</span>

            {progress && (
                <span className="progress">
                    <span style={{ width: `${progress * 100}%` }} />
                </span>
            )}
        </span>
    );
};
