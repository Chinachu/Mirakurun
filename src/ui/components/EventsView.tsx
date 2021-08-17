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
import { useState, useEffect, useRef } from "react";
import { Client as RPCClient } from "jsonrpc2-ws";
import { JoinParams } from "../../../lib/Mirakurun/rpc.d";
import { Event } from "../../../api";
import "./Logs.css";

let _itemId = 0;

let eventsCache: JSX.Element[] = [];

const EventsView: React.FC<{ uiStateEvents: EventEmitter, rpc: RPCClient }> = ({ uiStateEvents, rpc }) => {

    const [eventList, setEventList] = useState<JSX.Element[]>([]);
    const latestRef = useRef<HTMLDivElement>(null);

    const onEvents = (events: Event[], unshift: boolean) => {
        const newList: JSX.Element[] = [];
        for (const event of events) {
            newList.push(
                <div key={`events-list-item${_itemId}`} className={`type-${event.type}`}>
                    {`${event.resource} (${event.type}) ${JSON.stringify(event.data)}`}
                </div>
            );
            ++_itemId;
        }
        if (unshift === true) {
            eventsCache = [...newList, ...eventsCache].slice(-200);
        } else {
            eventsCache = [...eventsCache, ...newList].slice(-200);
        }
        setEventList(eventsCache);
    };

    useEffect(() => {

        const join = () => {
            rpc.call("join", { rooms: ["events:program"] } as JoinParams);
        };
        rpc.on("connected", join);
        join();

        (async () => {
            const events: Event[] = await (await fetch("/api/events")).json();
            onEvents(events, true);
        })();

        uiStateEvents.on("data:events", onEvents);

        return () => {
            rpc.off("connected", join);
            rpc.call("leave", { rooms: ["events:program"] } as JoinParams);
            uiStateEvents.off("data:events", onEvents);
            eventsCache = [];
        };
    }, []);

    useEffect(() => {
        latestRef.current.scrollIntoView();
    });

    return (
        <div className="logs" style={{ margin: "8px 0" }}>
            {eventList}
            <div className="latest" ref={latestRef}></div>
        </div>
    );
};

export default EventsView;
