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
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, NavLink, useNavigate, useLocation } from "react-router-dom";
import { FocusStyleManager } from "@blueprintjs/core";
FocusStyleManager.onlyShowFocusOnTabs();
import { DateTime, Settings as LuxonSettings } from "luxon";
LuxonSettings.defaultZone = "Asia/Tokyo";
LuxonSettings.defaultLocale = "ja";

import { state } from "./modules/state";
import * as ui from "./modules/ui";
import * as at from "./modules/at";
at.init(5000);

import { Nav } from "./components/Nav";
import { EPGView } from "./routes/EPGView";
import { ProgramView } from "./routes/ProgramView";
import { SearchView } from "./routes/SearchView";
import { JobsView } from "./routes/JobsView";
import { LogsView } from "./routes/LogsView";
import { ServerConfigView } from "./routes/ServerConfigView";
import { TunersConfigView } from "./routes/TunersConfigView";
import { ChannelsConfigView } from "./routes/ChannelsConfigView";

import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "./index.sass";

const Index: React.FC = () => {
    console.debug("Index");

    const navigate = state.navigate = useNavigate();
    const location = state.location = useLocation();
    const searchParams = state.searchParams = new URLSearchParams(location.search);
    const pathname = state.pathname = location.pathname;
    const pathLv1 = pathname.split("/")[1];

    useEffect(() => {
        ui.blur();
    }, [location.pathname]);

    return <>
        {state.isDev && /* 開発用 */ <>
            <div id="dev-header">
                [dev] {JSON.stringify({
                    pathname,
                    pathLv1,
                    searchParams: searchParams.toString()
                })}
            </div>
        </>}

        <Nav pathLv1={pathLv1} />

        <div id="main">
            <div id="page">
                <Routes>
                    <Route path="/*" element={<div>not found</div>} />

                    <Route path="/" element={<div>home</div>} />

                    <Route path="epg" element={<EPGView />} />
                    <Route path="epg/services/:globalServiceId" element={<EPGView />} />
                    <Route path="epg/programs/:programId" element={<ProgramView />} />
                    <Route path="epg/search" element={<SearchView />} />
                    <Route path="jobs" element={<JobsView />} />
                    <Route path="logs" element={<LogsView />} />
                    <Route path="config/server" element={<ServerConfigView />} />
                    <Route path="config/tuners" element={<TunersConfigView />} />
                    <Route path="config/channels" element={<ChannelsConfigView />} />

                    // todo:


                    <Route path="about" element={<div>about</div>} />
                </Routes>
            </div>
        </div>
    </>;
};

{
    const basename = state.isDev ? "/dev/" : "";
    const root = createRoot(document.getElementById("root"));
    root.render(<BrowserRouter basename={basename}><Index /></BrowserRouter>);
}
