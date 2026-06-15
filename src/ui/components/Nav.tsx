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
import { useEffect, useState, useCallback } from "react";
import { Alignment, Button, ButtonProps, Navbar, Menu, MenuItem, MenuDivider, Popover, PopoverTargetProps } from "@blueprintjs/core";
import { state } from "../modules/state";
import { useLocalStorageState } from "../hooks/useWebStorageState";
import { VersionStatus } from "./VersionStatus";
import { Restart } from "./Restart";

import "./Nav.sass";

type NavProps = {
    pathLv1: string;
};
export const Nav: React.FC<NavProps> = ({ pathLv1 }) => {
    console.debug("components", "Nav", pathLv1);

    const { navigate, searchParams } = state;
    const query = searchParams.get("q") || null;

    const [icon, setIcon] = useState<string>(state.statusIconSrc);
    useEffect(() => {
        const onStatusIconKey = () => {
            console.log("Nav", "onStatusIconKey", state.statusIconKey, state.statusIconSrc);
            setIcon(state.statusIconSrc);
        };
        state.on("statusIconKey", onStatusIconKey);
        return () => {
            state.off("statusIconKey", onStatusIconKey);
        };
    }, []);

    const [version, setVersion] = useState<string>(state.version);
    useEffect(() => {
        const onVersion = () => {
            console.log("Nav", "onVersion", state.version);
            setVersion(state.version);
        };
        state.on("version", onVersion);
        return () => {
            state.off("version", onVersion);
        };
    }, []);

    const [dark, setDark] = useLocalStorageState<boolean>("dark", true);
    useEffect(() => {
        document.body.classList.toggle("bp5-dark", dark);
    }, [dark]);

    const getNavbarButtonProps = useCallback((name: string, className = "") => {
        const props: ButtonProps = {
            onClick: () => {
                state.navigate("/" + name);
            }
        };

        if (name === pathLv1) {
            props.className = `${className} active`.trim();
        }

        return props;
    }, [pathLv1]);

    const [searchQuery, setSearchQuery] = useState<string>(query || "");
    const executeSearch = useCallback(() => {
        state.navigate(`/epg/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }, [searchQuery]);

    const [runningJobs, setRunningJobs] = useState<number>(state.jobs.filter((job) => job.status === "running").length);

    const [restartDialogOpen, setRestartDialogOpen] = useState<boolean>(false);
    useEffect(() => {
        const onJobs = () => {
            setRunningJobs(state.jobs.filter((job) => job.status === "running").length);
        };
        state.on("jobs", onJobs);
        return () => {
            state.off("jobs", onJobs);
        };
    }, []);

    return (
        <Navbar className="component-nav">
            <Navbar.Group align={Alignment.START}>
                <img className="product-icon" src={icon} alt={state.statusName} />
                <Navbar.Heading className="product-name">
                    Mirakurun
                    <sup className="version">{version}</sup>
                </Navbar.Heading>
                <div className="bp5-input-group">
                    <span className="bp5-icon bp5-icon-search"></span>
                    <input
                        type="text"
                        className="bp5-input"
                        placeholder="番組検索..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                executeSearch();
                            }
                        }}
                    />
                    <Button
                        variant="minimal"
                        className="bp5-intent-primary"
                        icon="arrow-right"
                        title="検索"
                        onClick={executeSearch}
                    />
                </div>
            </Navbar.Group>
            <Navbar.Group align={Alignment.END}>
                <Button variant="minimal" {...getNavbarButtonProps("")} icon="home" title="Home" text="Home" />
                <Button variant="minimal" {...getNavbarButtonProps("epg")} icon="timeline-events" title="EPG" text="EPG" />
                <Button variant="minimal" {...getNavbarButtonProps("jobs")} icon="ninja" title="ジョブ" text={
                    <>
                        ジョブ
                        {runningJobs !== 0 && <span className="badge">{runningJobs}</span>}
                    </>
                } />
                <Navbar.Divider />
                <Button variant="minimal" {...getNavbarButtonProps("logs")} icon="pulse" title="ログ" />
                <Popover
                    minimal
                    interactionKind="hover"
                    placement="bottom-end"
                    modifiers={{ offset: { enabled: true } }}
                    content={
                        <Menu>
                            {dark
                                ? <MenuItem icon="flash" text="ライトテーマ" onClick={() => { setDark(false); }} />
                                : <MenuItem icon="moon" text="ダークテーマ" onClick={() => { setDark(true); }} />
                            }
                            <MenuDivider />
                            <MenuItem onClick={() => { state.navigate("/config/server"); }} icon="wrench" text="サーバー設定" />
                            <MenuItem onClick={() => { state.navigate("/config/tuners"); }} icon="wrench" text="チューナー設定" />
                            <MenuItem onClick={() => { state.navigate("/config/channels"); }} icon="wrench" text="チャンネル設定" />
                            <MenuDivider />
                            <MenuItem onClick={() => { window.open("/api/debug", "_blank"); }} icon="document" text="API Docs" />
                            <MenuDivider />
                            <MenuItem onClick={() => { state.navigate("/about"); }} icon="info-sign" textClassName="product-name" text={`Mirakurun ${version} について`} />
                            <VersionStatus asMenuItem />
                            <MenuItem icon="power" intent="danger" text="再起動..." onClick={() => setRestartDialogOpen(true)} />
                        </Menu>
                    }
                    renderTarget={({ isOpen, ref, ...props }: PopoverTargetProps) => (
                        <Button {...props} active={isOpen} ref={ref} variant="minimal" icon="cog" />
                    )}
                />
                <Restart isOpen={restartDialogOpen} onClose={() => setRestartDialogOpen(false)} />
            </Navbar.Group>
        </Navbar>
    );
};
