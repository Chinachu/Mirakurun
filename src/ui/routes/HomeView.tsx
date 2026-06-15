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
import { useState, useEffect, useCallback } from "react";
import {
    Alignment,
    Breadcrumbs,
    Button,
    Checkbox,
    Dialog,
    DialogBody,
    DialogFooter,
    Icon,
    Navbar,
    NonIdealState,
    Section,
    Spinner,
    Tooltip,
    Tree,
    TreeNodeInfo
} from "@blueprintjs/core";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import { Service, Status, StreamInfo, TunerDevice } from "../../../api.d";

import "./HomeView.sass";

const summarizeStreamInfo = (streamInfo: StreamInfo): string => {
    if (!streamInfo) {
        return "-";
    }

    let packets = 0;
    let drops = 0;
    for (const pid in streamInfo) {
        packets += streamInfo[pid].packet;
        drops += streamInfo[pid].drop;
    }

    return `Dropped Pkts: ${drops} / ${packets}`;
};

const isEmptyStreamInfo = (streamInfo: StreamInfo): boolean => {
    if (!streamInfo) {
        return true;
    }
    return Object.keys(streamInfo).length === 0;
};

// --- Status Section ---

const StatusSection: React.FC<{ status: Status }> = ({ status }) => {
    if (!status) {
        return <Spinner size={20} />;
    }

    const dockerStat = status.process?.env?.DOCKER === "YES" ? " 🐋" : "";

    const items: { label: string; text: string }[] = [
        { label: "Platform", text: `${status.process?.platform} (${status.process?.arch})${dockerStat}` },
        { label: "Node.js Version", text: status.process?.versions?.node },
        { label: "Memory (RSS)", text: `${Math.round(status.process?.memoryUsage?.rss / 1024 / 1024)} MB` },
        { label: "EPG Gathering Network IDs", text: status.epg.gatheringNetworks.map(id => `0x${id.toString(16).toUpperCase()}`).join(", ") || "-" },
        { label: "EPG Stored Events", text: `${status.epg.storedEvents} Events` },
        { label: "TunerDevice Streams", text: `${status.streamCount.tunerDevice}` },
        { label: "TSFilter Streams", text: `${status.streamCount.tsFilter}` },
        { label: "Decoder Streams", text: `${status.streamCount.decoder}` },
        { label: "RPC Connections", text: `${status.rpcCount}` }
    ];

    return (
        <div className="status-grid">
            {items.map((item, i) => (
                <div key={i} className="status-item">
                    <span className="status-label">{item.label}</span>
                    <span className="status-value">{item.text}</span>
                </div>
            ))}
        </div>
    );
};

// --- Services Section ---

const ServicesSection: React.FC<{
    status: Status;
    services: Service[];
    allowPNA: boolean;
    tsplayEndpoint: string;
}> = ({ status, services, allowPNA, tsplayEndpoint }) => {
    const [showDTV, setShowDTV] = useState<boolean>(true);
    const [showData, setShowData] = useState<boolean>(false);
    const [showOthers, setShowOthers] = useState<boolean>(false);

    const filteredServices = services.filter(service => {
        if (service.type === 0x01 || service.type === 0xAD) {
            return showDTV;
        } else if (service.type === 0xC0) {
            return showData;
        }
        return showOthers;
    });

    return (
        <>
            <div className="service-filters">
                <Checkbox
                    label="DTV"
                    checked={showDTV}
                    onChange={() => setShowDTV(!showDTV)}
                    inline
                />
                <Checkbox
                    label="Data"
                    checked={showData}
                    onChange={() => setShowData(!showData)}
                    inline
                />
                <Checkbox
                    label="Others"
                    checked={showOthers}
                    onChange={() => setShowOthers(!showOthers)}
                    inline
                />
            </div>
            <div className="service-grid">
                {filteredServices.map((service) => (
                    <Tooltip
                        key={service.id}
                        content={
                            <div className="service-tooltip">
                                <div>#{service.id}</div>
                                <div>SID: 0x{service.serviceId.toString(16).toUpperCase()} ({service.serviceId})</div>
                                <div>NID: 0x{service.networkId.toString(16).toUpperCase()} ({service.networkId})</div>
                                <div>Type: 0x{service.type.toString(16).toUpperCase()} ({service.type})</div>
                                <div>Channel: {service.channel?.type} / {service.channel?.channel}</div>
                            </div>
                        }
                        placement="bottom"
                        hoverOpenDelay={300}
                    >
                        <div className="service-item">
                            {service.hasLogoData && (
                                <img
                                    className="service-logo"
                                    src={`/api/services/${service.id}/logo`}
                                    alt=""
                                />
                            )}
                            <span className="service-name">{service.name}</span>
                            <span className="service-epg-status">
                                {
                                    status?.epg.gatheringNetworks.includes(service.networkId) && <Icon icon="refresh" className="color-warning" size={12} /> ||
                                    service.epgReady && <Icon icon="tick" className="color-epg-ready" size={12} /> ||
                                    <Icon icon="time" className="bp5-text-muted" size={12} />
                                }
                            </span>
                            {service.type === 0x01 && allowPNA && tsplayEndpoint && (
                                <span
                                    className="service-play"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        window.open(
                                            `${tsplayEndpoint}#${location.protocol}//${location.host}/api/services/${service.id}/stream?decode=1`,
                                            "_blank",
                                            "popup"
                                        );
                                    }}
                                    title="TSPlay (Experimental)"
                                >
                                    <Icon icon="play" intent="primary" size={12} />
                                </span>
                            )}
                        </div>
                    </Tooltip>
                ))}
            </div>
        </>
    );
};

// --- Stream Info Table (for dialog) ---

const StreamInfoTable: React.FC<{
    userId: string;
    tuners: TunerDevice[];
    initialInfo: StreamInfo;
}> = ({ userId, tuners, initialInfo }) => {
    let currentInfo = initialInfo;
    for (const tuner of tuners) {
        const user = tuner.users.find(u => u.id === userId);
        if (user?.streamInfo) {
            currentInfo = user.streamInfo;
            break;
        }
    }

    const entries = Object.entries(currentInfo || {});
    if (entries.length === 0) {
        return <NonIdealState icon="info-sign" description="No stream info available." />;
    }

    return (
        <table className="bp5-html-table bp5-html-table-striped bp5-html-table-condensed stream-info-table">
            <thead>
                <tr>
                    <th>PID</th>
                    <th className="numeric">Packets</th>
                    <th className="numeric">Drops</th>
                </tr>
            </thead>
            <tbody>
                {entries.map(([pid, data]) => (
                    <tr key={pid}>
                        <td>{pid}</td>
                        <td className="numeric">{data.packet.toLocaleString()}</td>
                        <td className={`numeric${data.drop > 0 ? " color-danger" : ""}`}>{data.drop.toLocaleString()}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

// --- Tuners Section ---

const TunersSection: React.FC<{
    tuners: TunerDevice[];
}> = ({ tuners }) => {
    const [killTarget, setKillTarget] = useState<number>(null);
    const [tunersEx, setTunersEx] = useState<TunerDevice[]>([]);
    const [streamDetail, setStreamDetail] = useState<{ userId: string; info: StreamInfo }>(null);

    // get streamInfo periodically
    useEffect(() => {
        const interval = setInterval(async () => {
            if (document.hidden) {
                return;
            }
            try {
                const result = await (await fetch("/api/tuners")).json();
                setTunersEx(result);
            } catch (e) {
                console.warn(e);
            }
        }, 1000 * 5);

        return () => clearInterval(interval);
    }, []);

    // merge streamInfo from tunersEx into tuners
    const mergedTuners = tuners.map(tuner => {
        const tunerEx = tunersEx.find(t => t.index === tuner.index);
        if (tunerEx) {
            return {
                ...tuner,
                users: tuner.users.map(user => {
                    const userEx = tunerEx.users.find(u => u.id === user.id);
                    if (userEx?.streamInfo) {
                        return { ...user, streamInfo: userEx.streamInfo };
                    }
                    return user;
                })
            };
        }
        return tuner;
    });

    const treeNodes: TreeNodeInfo[] = mergedTuners.map((tuner) => {
        const tunerLabel = `#${tuner.index}: ${tuner.name} (${tuner.types.join(", ")})`;
        const hasUsers = tuner.users.length > 0;

        let tunerIcon: TreeNodeInfo["icon"];
        if (tuner.isFault) {
            tunerIcon = <Icon icon="error" intent="danger" />;
        } else if (!tuner.isAvailable) {
            tunerIcon = <Icon icon="disable" className="bp5-text-muted" />;
        } else if (tuner.isUsing) {
            tunerIcon = <Icon icon="dot" className="color-epg-ready" />;
        } else {
            tunerIcon = <Icon icon="dot" className="bp5-text-muted" />;
        }

        const childNodes: TreeNodeInfo[] = [];

        // device info node
        if (tuner.command || tuner.pid) {
            childNodes.push({
                id: `tuner-${tuner.index}-device`,
                icon: <Icon icon="console" className="bp5-text-muted" />,
                label: (
                    <span className="tuner-device-info">
                        <span>{tuner.command || "-"}</span>
                        {tuner.pid ? <span className="bp5-text-muted"> (pid={tuner.pid})</span> : null}
                        {tuner.command && (
                            <Button
                                variant="minimal"
                                icon="cross"
                                intent="danger"
                                onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    setKillTarget(tuner.index);
                                }}
                                title="Kill Tuner Process..."
                            />
                        )}
                    </span>
                ),
                hasCaret: false
            });
        }

        // user nodes
        for (let i = 0; i < tuner.users.length; i++) {
            const user = tuner.users[i];
            const isMirakurun = /Mirakurun/.test(user.id);

            const userInfoItems: JSX.Element[] = [
                <span key="priority" className="tuner-user-info-item">
                    <Icon icon="sort" className="bp5-text-muted" size={12} />
                    <span>{user.priority}</span>
                </span>,
                <span key="user" className="tuner-user-info-item">
                    <Icon icon={isMirakurun ? "cog" : "person"} className="bp5-text-muted" size={12} />
                    <span>{user.id}</span>
                </span>,
                <span key="ch" className="tuner-user-info-item">
                    <Icon icon="mobile-video" className="bp5-text-muted" size={12} />
                    <span>{user.streamSetting?.channel?.type} / {user.streamSetting?.channel?.channel}</span>
                </span>,
                <span key="sid" className="tuner-user-info-item">
                    <Icon icon="filter" className="bp5-text-muted" size={12} />
                    <span>{user.streamSetting?.serviceId ? `0x${user.streamSetting.serviceId.toString(16).toUpperCase()} (${user.streamSetting.serviceId})` : "-"}</span>
                </span>
            ];

            // stream info
            if (!isEmptyStreamInfo(user.streamInfo)) {
                userInfoItems.push(
                    <span key="stream" className="tuner-user-info-item">
                        <Icon icon="cube" className="bp5-text-muted" size={12} />
                        <a
                            className="stream-info-link"
                            onClick={(e) => {
                                e.stopPropagation();
                                setStreamDetail({ userId: user.id, info: user.streamInfo });
                            }}
                        >
                            {summarizeStreamInfo(user.streamInfo)}
                        </a>
                    </span>
                );
            }

            childNodes.push({
                id: `tuner-${tuner.index}-user-${i}`,
                label: <span className="tuner-user-info">{userInfoItems}</span>,
                hasCaret: false
            });
        }

        return {
            id: `tuner-${tuner.index}`,
            icon: tunerIcon,
            label: <span className="tuner-label">{tunerLabel}</span>,
            isExpanded: hasUsers || !!tuner.command,
            childNodes: childNodes.length > 0 ? childNodes : undefined,
            hasCaret: childNodes.length > 0
        };
    });

    const handleNodeCollapse = useCallback((_node: TreeNodeInfo) => {
        // Tree is stateless; for now we allow expand/collapse via Tree's own behavior
    }, []);

    const handleNodeExpand = useCallback((_node: TreeNodeInfo) => {
        // Tree is stateless
    }, []);

    return (
        <>
            {mergedTuners.length === 0 ? (
                <Spinner size={20} />
            ) : (
                <Tree
                    contents={treeNodes}
                    onNodeCollapse={handleNodeCollapse}
                    onNodeExpand={handleNodeExpand}
                    className="tuner-tree"
                />
            )}

            {/* Kill Tuner Process Dialog */}
            <Dialog
                isOpen={killTarget !== null}
                onClose={() => setKillTarget(null)}
                title="Kill Tuner Process"
                icon="warning-sign"
            >
                <DialogBody>
                    <p>Do you want to kill this running tuner process?</p>
                </DialogBody>
                <DialogFooter
                    actions={
                        <>
                            <Button
                                text="Cancel"
                                onClick={() => setKillTarget(null)}
                            />
                            <Button
                                intent="danger"
                                text="Kill"
                                onClick={() => {
                                    (async () => {
                                        await fetch(`/api/tuners/${killTarget}/process`, { method: "DELETE" });
                                    })();
                                    setKillTarget(null);
                                }}
                            />
                        </>
                    }
                />
            </Dialog>

            {/* Stream Info Detail Dialog */}
            <Dialog
                isOpen={!!streamDetail}
                onClose={() => setStreamDetail(null)}
                title="Stream Info"
                icon="cube"
                style={{ width: 500 }}
            >
                <DialogBody>
                    {streamDetail && (
                        <>
                            <p className="bp5-text-muted">{streamDetail.userId}</p>
                            <StreamInfoTable
                                userId={streamDetail.userId}
                                tuners={tunersEx}
                                initialInfo={streamDetail.info}
                            />
                        </>
                    )}
                </DialogBody>
                <DialogFooter
                    actions={
                        <Button
                            text="Close"
                            onClick={() => setStreamDetail(null)}
                        />
                    }
                />
            </Dialog>
        </>
    );
};

// --- HomeView ---

export const HomeView: React.FC = () => {
    console.debug("routes", "HomeView");

    ui.setTitle("Home");

    const [status, setStatus] = useState<Status>(state.status);
    const [services, setServices] = useState<Service[]>(state.services);
    const [tuners, setTuners] = useState<TunerDevice[]>(state.tuners);
    const [allowPNA, setAllowPNA] = useState<boolean>(false);
    const [tsplayEndpoint, setTsplayEndpoint] = useState<string>("");

    useEffect(() => {
        // fetch server config
        (async () => {
            try {
                if (!state.serverConfig) {
                    await state.fetchServerConfig();
                }
                if (state.serverConfig) {
                    setAllowPNA(state.serverConfig.allowPNA);
                    setTsplayEndpoint(state.serverConfig.tsplayEndpoint);
                }
            } catch (e) {
                console.error(e);
            }
        })();
    }, []);

    useEffect(() => {
        const onStatus = () => {
            setStatus({ ...state.status });
        };
        state.on("status", onStatus);

        const onServices = () => {
            setServices([...state.services]);
        };
        state.on("services", onServices);

        const onTuners = () => {
            setTuners([...state.tuners]);
        };
        state.on("tuners", onTuners);

        return () => {
            state.off("status", onStatus);
            state.off("services", onServices);
            state.off("tuners", onTuners);
        };
    }, []);

    const toolbar = (
        <Navbar className="toolbar">
            <Navbar.Group align={Alignment.START}>
                <Navbar.Heading>
                    <Breadcrumbs items={[
                        {
                            text: "Home"
                        }
                    ]} />
                </Navbar.Heading>
            </Navbar.Group>
        </Navbar>
    );

    return (
        <div className="route" id="route-home-view">
            {toolbar}

            <div className="content">
                <div className="home-container">
                    <Section className="home-section" title="Status" icon="dashboard" compact>
                        <div className="home-section-content">
                            <StatusSection status={status} />
                        </div>
                    </Section>

                    <Section
                        className="home-section"
                        title={`Services${services.length > 0 ? ` (${services.length})` : ""}`}
                        icon="globe-network"
                        compact
                    >
                        <div className="home-section-content">
                            <ServicesSection
                                status={status}
                                services={services}
                                allowPNA={allowPNA}
                                tsplayEndpoint={tsplayEndpoint}
                            />
                        </div>
                    </Section>

                    <Section
                        className="home-section"
                        title={`Tuners${tuners.length > 0 ? ` (${tuners.length})` : ""}`}
                        icon="antenna"
                        compact
                    >
                        <div className="home-section-content">
                            <TunersSection tuners={tuners} />
                        </div>
                    </Section>
                </div>
            </div>
        </div>
    );
};
