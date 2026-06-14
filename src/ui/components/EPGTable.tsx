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
import ScrollContainer from "react-indiana-drag-scroll";
import { Button, Spinner, NonIdealState } from "@blueprintjs/core";
import { DateTime } from "luxon";
import sift, { Query } from "sift";
import { LazyCaller } from "../modules/common";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import * as regexp from "../modules/regexp";
import { GenreUN2Map } from "../modules/constants";
import { Error, ChannelType, Service, Program, ProgramGenre } from "../../../api.d";

import { ProgramTitle } from "./ProgramTitle";
import { ProgramPopover } from "./ProgramPopover";
import { ProgramGenres } from "./ProgramGenres";

import "./EPGTable.sass";

const scrollState = {
    left: {
        GR: -1,
        BS: -1,
        CS: -1,
        SKY: -1,
    },
    top: -1,
};

interface Dimensions {
    // headerHeight: number;
    // timescaleWidth: number;
    timescaleHeight: number;
    blockWidth: number;
    // blockHeight: number;
    scaleFactor: number;
}

type EPGTableProps = {
    date: DateTime;
    channelType?: ChannelType;
    globalServiceId?: number;
    defaultProgramId?: number;
    defaultTime?: number;
};
export const EPGTable: React.FC<EPGTableProps> = ({ date, channelType, globalServiceId, defaultProgramId, defaultTime }) => {
    console.debug("components", "EPGTable");

    const startTime = date.toMillis();

    const headerRef = useRef<HTMLDivElement>();
    const timescaleRef = useRef<HTMLDivElement>();
    const timelineRef = useRef<HTMLDivElement>();
    const clockRef = useRef<HTMLDivElement>();
    const timetableRef = useRef<HTMLDivElement>();
    const headerItemRef = useRef<HTMLDivElement>();
    const timescaleItemRef = useRef<HTMLDivElement>();
    const jumpToTimelineRef = useRef<HTMLButtonElement>();

    const [reload, setReload] = useState(0); // リロード用
    const [dimensions, setDimensions] = useState<Dimensions>(null);
    const [error, setError] = useState<Error>(null);

    // null = loading, [] = empty
    const [programId, setProgramId] = useState<number>(defaultProgramId || null);
    const [time, setTime] = useState<number>(defaultTime || null);
    const [services, setServices] = useState<Service[]>(null);
    const [serviceItems, setServiceItems] = useState<JSX.Element[]>(null);
    const [timetableCols, setTimetableCols] = useState<JSX.Element[]>(null);

    if (globalServiceId) {
        // 週間番組表
        if (services) {
            ui.setTitle(services[0]?.name);
        } else if (error) {
            ui.setTitle("エラー");
        }
    }

    useEffect(() => {
        const onUpdated = () => {
            setReload(Date.now());
        }
        const onUpdatedLazy = new LazyCaller(0, 1000, onUpdated);

        state.on("services", onUpdatedLazy.caller);
        state.on("programs", onUpdatedLazy.caller);

        state.subscribePrograms(true);

        return () => {
            state.off("services", onUpdatedLazy.caller);
            state.off("programs", onUpdatedLazy.caller);
            onUpdatedLazy.destroy();
        }
    }, []);

    useEffect(() => {
        return () => {
            setError(null);
        };
    }, [state.location, reload]);

    useEffect(() => {
        return () => {
            setServices(null);
            setServiceItems(null);
        };
    }, [channelType]);

    useEffect(() => {
        return () => {
            setTimetableCols(null);
        };
    }, [channelType]);

    // 採寸
    useEffect(() => {
        const timescale = timescaleRef.current;
        const headerItem = headerItemRef.current;
        const timescaleItem = timescaleItemRef.current;

        // 採寸
        setDimensions({
            // headerHeight: headerItem.offsetHeight,
            // timescaleWidth: timescaleItem.offsetWidth,
            timescaleHeight: timescale.scrollHeight,
            blockWidth: headerItem.offsetWidth,
            // blockHeight: timescaleItem.offsetHeight,
            scaleFactor: timescaleItem.offsetHeight / 60,
        });
    }, []);

    // スクロール連動・現在時刻・現在線の描画
    useEffect(() => {
        if (!dimensions) {
            return;
        }

        const header = headerRef.current;
        const timescale = timescaleRef.current;
        const timeline = timelineRef.current;
        const clock = clockRef.current;
        const timetable = timetableRef.current;
        const jumpToTimeline = jumpToTimelineRef.current;

        if (!timetableCols) {
            return;
        }

        const getPosition = () => Math.floor((Date.now() - state.todayTime) / 1000 / 60 * dimensions.scaleFactor);

        // スクロール連動
        const onScroll = () => {
            scrollState.left[channelType] = header.scrollLeft = timetable.scrollLeft;
            scrollState.top = timescale.scrollTop = timetable.scrollTop;
        };
        timetable.addEventListener("scroll", onScroll);

        // 現在時刻を表示する
        timeline.style.opacity = "";
        let showClockTimeout: ReturnType<typeof setTimeout>;
        const showClock = () => {
            showClockTimeout = setTimeout(() => timeline.classList.remove("show"), 1000);
            timeline.classList.add("show");
        };
        showClock();

        // スクロール初期位置セット
        timetable.scrollLeft = Math.round(
            scrollState.left[channelType] > -1
            ? scrollState.left[channelType]
            : 0
        );
        if (time) {
            // スクロール時間指定
            const position = Math.floor(time / 1000 / 60 * dimensions.scaleFactor);
            timetable.scrollTop = Math.round(position - timetable.clientHeight / 4);
            setTime(null);
        } else {
            // 現在時刻
            timetable.scrollTop = Math.round(
                scrollState.top > -1
                ? scrollState.top
                : (getPosition() - timetable.clientHeight / 4)
            );
        }

        // 現在線の描画
        const updateTimeline = () => {
            const position = getPosition();
            const { scrollTop, clientHeight } = timetable;

            // 色切り替え
            if (state.todayTime === startTime) {
                // 今日
                timeline.classList.add("today");
            } else {
                // 今日じゃない
                timeline.classList.remove("today");
            }

            // 現在線位置
            timeline.style.top = `${position}px`;

            // 時刻表示
            const clockText = DateTime.now().toFormat("HH:mm");
            if (clock.innerText !== clockText) {
                clock.innerText = clockText;
                showClock();
            }

            // ボタン表示
            if (position > scrollTop && position < scrollTop + clientHeight) {
                jumpToTimeline.classList.add("hide");
            } else {
                jumpToTimeline.classList.remove("hide");
            }
        };
        const updateTimelineInterval = setInterval(updateTimeline, 1500);
        updateTimeline();

        return () => {
            timetable.removeEventListener("scroll", onScroll);
            clearInterval(updateTimelineInterval);
            clearTimeout(showClockTimeout);
        };
    }, [startTime, timetableCols]);

    // サービス一覧の取得
    useEffect(() => {
        if (!dimensions) {
            return;
        }

        if (globalServiceId) {
            // 週間番組表
            const _service = state.services.find(s => s.id === globalServiceId);
            if (!_service) {
                setError({ code: 404, reason: "サービスが見つかりません" });
                return;
            }
            setServices([_service]);
            return;
        }

        // 全体番組表
        const _services = state.services
            .filter(s => s.type === 1)
            .filter(s => channelType ? s.channel.type === channelType : true);

        // ソート
        _services.sort((a, b) => {
            if (a.remoteControlKeyId && b.remoteControlKeyId) {
                return a.remoteControlKeyId - b.remoteControlKeyId;
            }
            if (a.remoteControlKeyId && !b.remoteControlKeyId) {
                return -1;
            }
            if (!a.remoteControlKeyId && b.remoteControlKeyId) {
                return 1;
            }
            return a.id - b.id;
        });

        setServices(_services);
    }, [channelType, dimensions, reload]);

    // 番組一覧
    useEffect(() => {
        if (!services || services.length === 0) {
            return;
        }

        console.debug("EPGTable", "services", services);

        const query: Query<Program> = {
            startAt: {
                $gte: startTime - 60 * 60 * 2 * 1000,
                $lt: startTime + 60 * 60 * 28 * 1000
            }
        };
        if (channelType) {
            query.serviceId = { $in: services.map(s => s.serviceId) };
        } else if (globalServiceId) {
            query.serviceId = services[0].serviceId;
            query.startAt["$lt"] = startTime + 60 * 60 * 24 * 8 * 1000;
        }
        const filteredPrograms = state.programs.filter(sift(query));

        console.debug("EPGTable", "filteredPrograms", filteredPrograms);

        const programMap = new Map<string, Program>(); // イベントグループ検索用
        const _serviceItems: JSX.Element[] = [];
        const cols: JSX.Element[] = [];

        // サービスごとにループ
        for (let i = 0; i < services.length; i++) {
            const service = services[i];
            const servicePrograms: Program[] = [];
            let count = 0;

            // サービス絞り込み
            for (const program of filteredPrograms) {
                if (program.serviceId !== service.serviceId || program.networkId !== service.networkId) {
                    continue;
                }
                if (program.relatedItems?.filter(item => item.type === "shared").length !== 1) {
                    // オリジナルイベントのみをカウント
                    count++;
                    // イベントグループ被参照対象
                    programMap.set(`${program.serviceId}.${program.eventId}`, program);
                }
                servicePrograms.push(program);
            }

            if (count === 0) {
                continue;
            }

            // ソート
            servicePrograms.sort((a, b) => {
                return a.startAt - b.startAt;
            });

            if (!globalServiceId) {
                // 全体番組表
                let className = "epg-table-header-item";

                _serviceItems.push(
                    <button className={className} key={service.id}
                        onClick={() => {
                            state.navigate(`/epg/services/${service.id}?date=${date.toISODate()}`);
                        }}
                    >
                        {service.hasLogoData && <img src={`/api/services/${service.id}/logo`} />}
                        <span>{service.name}</span>
                    </button>
                );
            } else {
                // 週間番組表
                for (let i = 0; i < 8; i++) {
                    const cur = date.plus({ days: i });

                    _serviceItems.push(
                        <button className="epg-table-header-item date" key={`${service.id}-${i}`}
                            onClick={() => {
                                state.navigate(`/epg?type=${service.channel.type}&date=${cur.toISODate()}`);
                            }}
                        >
                            <span>{cur.toFormat("M月d日（ccc）")}</span>
                        </button>
                    );
                }
            }

            // 放送終了ダミーデータ挿入
            const last = servicePrograms[servicePrograms.length - 1];
            servicePrograms.push({
                id: last.id + 0.1,
                eventId: last.eventId + 0.1,
                serviceId: last.serviceId,
                networkId: last.networkId,
                startAt: last.startAt + last.duration,
                duration: 60 * 15 * 1000,
                isFree: false,
                name: service.epgReady ? "(放送休止・未定)" : "(未受信)",
                description: "no-data",
                genres: [],
            });

            const cells: JSX.Element[] = [];
            // 週間番組表用
            const splitIndexes: number[] = [];
            const maxHeight = 60 * 24 * dimensions.scaleFactor;
            let topOffset = 0;

            for (let i = 0; i < servicePrograms.length; i++) {
                let program = { ...servicePrograms[i] };
                let className = "timetable-cell";

                const prev = servicePrograms[i - 1];
                if (prev && (prev.startAt + prev.duration) !== program.startAt) {
                    // 放送未定ダミーデータ挿入
                    program = {
                        id: prev.id + 0.1,
                        eventId: prev.eventId + 0.1,
                        serviceId: prev.serviceId,
                        networkId: prev.networkId,
                        startAt: prev.startAt + prev.duration,
                        duration: program.startAt - (prev.startAt + prev.duration),
                        isFree: false,
                        name: service.epgReady ? "(放送休止・未定)" : "(未受信)",
                        description: "no-data",
                        genres: [],
                    };

                    servicePrograms.splice(i, 0, program);
                }

                if (program.description === "no-data") {
                    className += " no-data";
                    program.description = undefined;
                }

                const programStartTime = program.startAt;
                const programStartDate = new Date(program.startAt);

                let top = Math.floor((programStartTime - startTime) / 1000 / 60 * dimensions.scaleFactor) + topOffset;
                let height = Math.floor(program.duration / 1000 / 60 * dimensions.scaleFactor);
                if (globalServiceId) {
                    // 週間番組表用
                    if (top + height >= maxHeight) {
                        // 日付跨ぎ
                        splitIndexes.push(i + 1);
                        topOffset -= maxHeight;

                        // 日付の最後の番組を24時の位置に合わせる
                        height -= top + height - maxHeight;

                        // 分割
                        servicePrograms.splice(i, 0, {
                            ...program,
                        });
                    }
                }
                if (top < 0) {
                    // 日付の最初の番組を0時の位置に合わせる
                    height += top;
                    top = 0;
                }

                const isShort = height <= 40;
                if (isShort) {
                    className += " short";

                    if (height <= 16) {
                        className += " x-short";
                    }
                    if (height <= 10) {
                        className += " xx-short";
                    }
                } else {
                    if (height >= 240) {
                        className += " long";
                    }
                }

                if (program.relatedItems && program.relatedItems.filter(item => item.type === "shared").length === 1) {
                    className += " event-group-shared";

                    const ref = programMap.get(`${program.relatedItems[0].serviceId}.${program.relatedItems[0].eventId}`)
                    if (ref) {
                        program.name = program.name || ref.name;
                        program.genres = program.genres || ref.genres;
                        program.description = program.description || "(イベント共有)";
                    }
                }

                const cautions: ProgramGenre[] = [];

                if (program.genres && program.genres[0]) {
                    className += ` bg-genre-lv1-${program.genres[0].lv1}`;

                    for (const genre of program.genres) {
                        const un2Text = GenreUN2Map[(genre.lv1 * 0x1000) + (genre.lv2 * 0x100) + (genre.un1 * 0x10) + genre.un2];
                        if (un2Text) {
                            cautions.push(genre);
                        }
                    }
                }

                const defaultIsOpen = programId === program.id;
                if (defaultIsOpen) {
                    setProgramId(null);
                }

                cells.push(
                    <ProgramPopover
                        key={`event-${program.eventId}-${program.startAt}`}
                        className={className}
                        program={program}
                        defaultIsOpen={defaultIsOpen}
                        renderTarget={({ isOpen, ...props }) => (
                            <button style={{ top, height }} {...props}>
                                <div>
                                    <time dateTime={programStartDate.toISOString()}>{programStartDate.getMinutes()}</time>
                                    <ProgramTitle program={program} />
                                    {!isShort && program.description && (
                                        <div className="description">{program.description.replace(regexp.enclosedAttributeUnicode, "")}</div>
                                    )}
                                    {!isShort && cautions.length > 0 && <ProgramGenres genres={cautions} />}
                                </div>
                            </button>
                        )}
                    />
                );
            }

            if (!globalServiceId) {
                // 全体番組表
                cols.push(
                    <div key={service.id}
                        className="timetable-col"
                        style={{ width: dimensions.blockWidth, height: dimensions.timescaleHeight }}
                    >
                        {cells}
                    </div>
                );
            } else {
                // 週間番組表
                for (let i = 0; i < splitIndexes.length; i++) {
                    cols.push(
                        <div key={`${service.id}-${i}`}
                            className="timetable-col"
                            style={{ width: dimensions.blockWidth, height: maxHeight }}
                        >
                            {cells.slice(splitIndexes[i - 1] || 0, splitIndexes[i] || cells.length)}
                        </div>
                    );
                }
            }
        }

        setServiceItems(_serviceItems);
        setTimetableCols(cols);
    }, [startTime, services]);

    const timescaleDateShort = date.toFormat("M/d(ccc)");
    const timescaleDateExtended = date.plus({ days: 1 }).toFormat("M/d(ccc)");

    return (
        <div className="component-epg-table">
            <div className="header" ref={headerRef}>
                {!serviceItems && !error && <>
                    <div className="epg-table-header-item loading" ref={headerItemRef}><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                    <div className="epg-table-header-item loading"><div className="bp5-skeleton img" /><span className="bp5-skeleton" /></div>
                </>}
                {serviceItems}
            </div>

            <div className="timescale" ref={timescaleRef}>
                <div className="timeline" ref={timelineRef}>
                    <div className="clock" ref={clockRef}>00:00</div>
                </div>
                <div className="timescale-item hour-0" ref={timescaleItemRef}><div>{timescaleDateShort} 0時</div></div>
                <div className="timescale-item hour-1"><div>1</div></div>
                <div className="timescale-item hour-2"><div>2</div></div>
                <div className="timescale-item hour-3"><div>{timescaleDateShort} 3時</div></div>
                <div className="timescale-item hour-4"><div>4</div></div>
                <div className="timescale-item hour-5"><div>5</div></div>
                <div className="timescale-item hour-6"><div>{timescaleDateShort} 6時</div></div>
                <div className="timescale-item hour-7"><div>7</div></div>
                <div className="timescale-item hour-8"><div>8</div></div>
                <div className="timescale-item hour-9"><div>{timescaleDateShort} 9時</div></div>
                <div className="timescale-item hour-10"><div>10</div></div>
                <div className="timescale-item hour-11"><div>11</div></div>
                <div className="timescale-item hour-12"><div>{timescaleDateShort} 12時</div></div>
                <div className="timescale-item hour-13"><div>13</div></div>
                <div className="timescale-item hour-14"><div>14</div></div>
                <div className="timescale-item hour-15"><div>{timescaleDateShort} 15時</div></div>
                <div className="timescale-item hour-16"><div>16</div></div>
                <div className="timescale-item hour-17"><div>17</div></div>
                <div className="timescale-item hour-18"><div>{timescaleDateShort} 18時</div></div>
                <div className="timescale-item hour-19"><div>19</div></div>
                <div className="timescale-item hour-20"><div>20</div></div>
                <div className="timescale-item hour-21"><div>{timescaleDateShort} 21時</div></div>
                <div className="timescale-item hour-22"><div>22</div></div>
                <div className="timescale-item hour-23"><div>23</div></div>
                <div className="timescale-item hour-0"><div>{timescaleDateExtended} 0時 (24)</div></div>
                <div className="timescale-item hour-1"><div>1 (25)</div></div>
                <div className="timescale-item hour-2"><div>2 (26)</div></div>
                <div className="timescale-item hour-3"><div>{timescaleDateExtended} 3時 (27)</div></div>
                {timetableCols && <div className="timescale-item reserve"><div></div></div>}
            </div>

            <Button variant="outlined" className="jump-to-timeline hide" ref={jumpToTimelineRef} icon="selection"
                text="現在時刻へ"
                onClick={() => {
                    ui.blur();
                    jumpToTimelineRef.current.classList.add("hide");

                    const { clientHeight } = timetableRef.current;
                    const { offsetTop } = timelineRef.current;
                    timetableRef.current.scrollTop = offsetTop - clientHeight / 4;
                }}
            />

            <ScrollContainer className="timetable" innerRef={timetableRef} hideScrollbars={false}
                onClick={(a) => {
                    ui.blur();
                }}
            >
                {!error && timetableCols === null
                    ? <Spinner intent="none" size={40} />
                    : timetableCols
                }
            </ScrollContainer>

            {(state.programs.length === 0 || state.services.length === 0) && !error && <>
                <NonIdealState
                    icon={<Spinner />}
                    title="ロード中"
                    description="データを待機しています..."
                />
            </> || services?.length === 0 && !error && <>
                <NonIdealState
                    icon="satellite"
                    title="放送サービスなし"
                    description="指定された放送波のチャンネルが見つかりません"
                />
            </> || timetableCols?.length === 0 && !error && <>
                <NonIdealState
                    icon="satellite"
                    title="放送イベントなし"
                    description="指定された日付と放送波の番組情報が見つかりません"
                />
            </>}

            {error && <>
                <NonIdealState
                    icon="warning-sign"
                    title={`${error.code} Error`}
                    description={error.reason || "エラーが発生しました"}
                />
            </>}
        </div>
    );
};
