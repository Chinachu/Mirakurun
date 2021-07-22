/*
   Copyright 2021 kanreisa

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
import { useState } from "react";
import {
    getTheme,
    FontWeights,
    mergeStyleSets,
    IButtonStyles,
    IconButton,
    IStackProps,
    ActionButton,
    Modal,
    Stack,
    Separator,
    Label,
    TextField,
    TooltipHost,
    Icon
} from "@fluentui/react";

function selectHandler(e: React.MouseEvent<HTMLInputElement>) {
    e.currentTarget.select();
}

const ConnectionGuide: React.FC = () => {

    const [isModalOpen, setModalOpen] = useState<boolean>(false);

    const theme = getTheme();
    const contentStyles = mergeStyleSets({
        container: {
            display: "flex",
            flexFlow: "column nowrap",
            alignItems: "stretch",
        },
        header: [
            theme.fonts.xLarge,
            {
                flex: "1 1 auto",
                borderTop: `4px solid ${theme.palette.themePrimary}`,
                color: theme.palette.themePrimary,
                display: "flex",
                alignItems: "center",
                fontWeight: FontWeights.semibold,
                padding: "12px 12px 14px 24px",
            },
        ],
        body: {
            flex: "4 4 auto",
            padding: "0 24px 24px 24px",
            overflowY: "hidden",
            width: "75vw",
            minWidth: "400px",
            maxWidth: "500px",
            selectors: {
                p: { margin: "14px 0" },
                "p:first-child": { marginTop: 0 },
                "p:last-child": { marginBottom: 0 },
            },
        },
    });
    const stackProps: Partial<IStackProps> = {
        tokens: { childrenGap: 8 },
        styles: { root: { marginBottom: 20 } },
    };
    const iconButtonStyles: Partial<IButtonStyles> = {
        root: {
            color: theme.palette.neutralPrimary,
            marginLeft: "auto",
            marginTop: "4px",
            marginRight: "2px",
        },
        rootHovered: {
            color: theme.palette.neutralDark,
        },
    };

    return (
        <>
            <Modal
                titleAriaId="connection-guide-title"
                isOpen={isModalOpen}
                onDismiss={() => setModalOpen(false)}
                isBlocking={false}
                containerClassName={contentStyles.container}
            >
                <div className={contentStyles.header}>
                    <span id="connection-guide-title">Connection Guide</span>
                    <IconButton
                        styles={iconButtonStyles}
                        iconProps={{ iconName: "Cancel" }}
                        ariaLabel="Close"
                        onClick={() => setModalOpen(false)}
                    />
                </div>
                <div className={contentStyles.body}>
                    <Stack {...stackProps}>
                        <TextField readOnly
                            label="Mirakurun Path"
                            value={`${location.protocol}//${location.host}/`}
                            onMouseOver={selectHandler} onClick={selectHandler}
                        />
                        <TextField readOnly
                            label="Open API 2.0 / Swagger 2.0 Compliant Definition"
                            value={`${location.protocol}//${location.host}/api/docs`}
                            onMouseOver={selectHandler} onClick={selectHandler}
                        />
                        <Separator>IPTV</Separator>
                        <TextField readOnly
                            label="M3U Playlist"
                            value={`${location.protocol}//${location.host}/api/iptv/playlist`}
                            onMouseOver={selectHandler} onClick={selectHandler}
                        />
                        <TextField readOnly
                            label="XMLTV"
                            value={`${location.protocol}//${location.host}/api/iptv/xmltv`}
                            onMouseOver={selectHandler} onClick={selectHandler}
                        />
                        <TextField readOnly
                            label="HDHomeRun Device Address"
                            value={`${location.protocol}//${location.host}/api/iptv`}
                            onMouseOver={selectHandler} onClick={selectHandler}
                            onRenderLabel={(props) => (
                                <Stack horizontal verticalAlign="end">
                                    <Label>{props.label}</Label>
                                    <TooltipHost content="Tested on Plex Media Server">
                                        <Icon
                                            iconName="Info"
                                            style={{ marginLeft: 4, marginBottom: 6 }}
                                        />
                                    </TooltipHost>
                                </Stack>
                            )}
                        />
                        <Separator>Misc</Separator>
                        <TextField readOnly
                            label="BonDriver_Mirakurun.ini"
                            multiline rows={3}
                            value={`[GLOBAL]\nSERVER_HOST="${location.hostname}"\nSERVER_PORT="${location.port}"`}
                            onMouseOver={selectHandler} onClick={selectHandler}
                        />
                    </Stack>
                </div>
            </Modal>
            <ActionButton
                iconProps={{ iconName: "Info" }}
                text="Connection Guide"
                onClick={() => setModalOpen(true)}
            />
        </>
    );
};

export default ConnectionGuide;
