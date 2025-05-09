import * as React from "react";
import { useState, useEffect } from "react";
import { Button, ButtonGroup, ButtonProps, Menu, MenuItem, Popover, PopoverTargetProps, Placement } from "@blueprintjs/core";
import { copyToClipboard } from "../modules/common";
import { state } from "../modules/state";

type WatchButtonProps = {
    globalServiceId: number;
    popoverPlacement?: Placement;
} & ButtonProps & React.HTMLAttributes<HTMLButtonElement>;

export const WatchButton: React.FC<WatchButtonProps> = ({ globalServiceId, popoverPlacement, ...props }) => {
    console.debug("components", "WatchButton");

    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            if (state.serverConfig) {
                setLoading(false);
                return;
            }

            await state.fetchServerConfig();

            if (state.serverConfig) {
                setLoading(false);
            }
        })();
    }, []);

    const tsplayDisabled = !state.serverConfig?.tsplayEndpoint || !state.serverConfig?.allowPNA;
    const streamEndpoint = `${location.protocol}//${location.host}/api/services/${globalServiceId}/stream`;

    return (<>
        <ButtonGroup className={loading ? "bp5-skeleton" : ""}>
            <Button {...props}
                text="視聴テスト"
                icon="play"
                endIcon="lab-test"
                disabled={tsplayDisabled}
                onPointerUp={e => {
                    if (tsplayDisabled) {
                        return;
                    }
                    // e.preventDefault();
                    // e.stopPropagation();

                    // マウス中クリックか ctrl 押しながら左クリックか判定
                    const isMiddleButton = e.button === 1 || (e.button === 0 && e.ctrlKey);

                    let features = "noreferrer";
                    if (isMiddleButton) {
                        // features += "";
                    } else {
                        const width = 1280;
                        const height = 770;
                        // winPosX, winPosY は現在のブラウザウィンドウの画面上の真ん中に設定
                        const top = window.screenTop + (window.innerHeight / 2) - (height / 2);
                        const left = window.screenLeft + (window.innerWidth / 2) - (width / 2);

                        features += `,popup,width=${width},height=${height},top=${top},left=${left},resizable=yes`;
                    }

                    const openUrl = `${state.serverConfig.tsplayEndpoint}#${streamEndpoint}`;
                    window.open(openUrl, `_blank`, features);
                }}
            />

            <Popover
                hasBackdrop={true}
                onClose={e => {
                    e.preventDefault();
                    e.stopPropagation();
                }}
                captureDismiss={true}
                placement={popoverPlacement}
                positioningStrategy="absolute"
                content={
                    <Menu>
                        <MenuItem icon="clipboard" text="URL をクリップボードにコピー" onClick={() => {
                            copyToClipboard(streamEndpoint);
                        }} />
                        <MenuItem icon="desktop" text="M3U プレイリスト..." onClick={() => {
                            const m3u8Content = (
                                `#EXTM3U\n` +
                                `#EXTINF:-1,\n` +
                                `${streamEndpoint}\n`
                            );
                            const blob = new Blob([m3u8Content], { type: "application/x-mpegURL" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `Mirakurun_service_${globalServiceId}.m3u8`;
                            document.body.appendChild(a);
                            a.click();

                            setTimeout(() => {
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                            }, 100);
                        }} />
                    </Menu>
                }
                renderTarget={({ isOpen, ref, ...targetProps }: PopoverTargetProps) => (
                    <Button {...{...props, text: ""}} {...targetProps} active={isOpen} ref={ref} icon="more" title="再生方法..." />
                )}
            />
        </ButtonGroup>
    </>);
};
