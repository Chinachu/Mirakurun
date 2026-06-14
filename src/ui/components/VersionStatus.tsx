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
import { useEffect, useState } from "react";
import { MenuItem } from "@blueprintjs/core";
import * as semver from "semver";
import { state } from "../modules/state";

interface VersionInfo {
    current: string;
    latest: string;
}

let cachedVersion: VersionInfo | null = null;
let isFetching = false;
const fetchListeners: Array<(version: VersionInfo | null) => void> = [];

const fetchVersion = async (): Promise<VersionInfo | null> => {
    if (cachedVersion) {
        return cachedVersion;
    }
    if (isFetching) {
        return new Promise((resolve) => {
            fetchListeners.push(resolve);
        });
    }
    isFetching = true;
    try {
        const res = await fetch("/api/version");
        if (res.ok) {
            const data: VersionInfo = await res.json();
            cachedVersion = data;
            const listeners = [...fetchListeners];
            fetchListeners.length = 0;
            listeners.forEach((resolve) => resolve(data));
            return data;
        }
    } catch (e) {
        console.error("Failed to fetch version", e);
    }
    isFetching = false;
    const listeners = [...fetchListeners];
    fetchListeners.length = 0;
    listeners.forEach((resolve) => resolve(null));
    return null;
};

export const VersionStatus: React.FC<{
    asMenuItem?: boolean;
}> = ({ asMenuItem = false }) => {
    const [version, setVersion] = useState<VersionInfo | null>(cachedVersion);
    const [loading, setLoading] = useState<boolean>(!cachedVersion);

    useEffect(() => {
        let isMounted = true;
        if (!cachedVersion) {
            fetchVersion().then((data) => {
                if (isMounted) {
                    setVersion(data);
                    setLoading(false);
                }
            });
        } else {
            setLoading(false);
        }
        return () => {
            isMounted = false;
        };
    }, []);

    const hasUpdate = version
        && semver.valid(version.current)
        && semver.valid(version.latest)
        && semver.gt(version.latest, version.current);

    if (asMenuItem) {
        if (loading) {
            return <MenuItem icon="updated" text="アップデートを確認中..." disabled />;
        }
        if (!version) {
            return <MenuItem icon="updated" text="最新版を実行中です" disabled />;
        }
        if (hasUpdate) {
            return (
                <MenuItem
                    icon="updated"
                    intent="primary"
                    text={`最新版 (v${version.latest}) が利用可能です`}
                    onClick={() => {
                        state.navigate("/about");
                    }}
                />
            );
        }
        return <MenuItem icon="updated" text="最新版を実行中です" disabled />;
    }

    if (loading) {
        return <span>アップデートを確認中...</span>;
    }
    if (!version) {
        return <span>不明 (取得失敗)</span>;
    }

    if (hasUpdate) {
        return (
            <span style={{ color: "#2d72d9", fontWeight: "bold" }}>
                {version.latest} (新しいバージョンが利用可能です)
            </span>
        );
    }

    return <span>{version.latest} (最新版を実行中です)</span>;
};
