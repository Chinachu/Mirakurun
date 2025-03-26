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
import {
    Dialog,
    DialogFooter,
    DialogType,
    PrimaryButton,
    DefaultButton,
    ActionButton,
    Coachmark,
    TeachingBubbleContent,
    DirectionalHint
} from "@fluentui/react";

const Restart: React.FC<{ uiStateEvents: EventEmitter }> = ({ uiStateEvents }) => {
    const [hideDialog, setHideDialog] = useState<boolean>(true);
    const [restartRequired, setRestartRequired] = useState<boolean>(false);
    const targetButton = useRef<HTMLDivElement>();

    useEffect(() => {
        const onRestartRequired = () => {
            setRestartRequired(true);
        };
        uiStateEvents.on("notify:restart-required", onRestartRequired);
        return () => {
            uiStateEvents.off("notify:restart-required", onRestartRequired);
        };
    }, []);

    return (
        <>
            <Dialog
                hidden={hideDialog}
                onDismiss={() => setHideDialog(true)}
                dialogContentProps={{
                    type: DialogType.largeHeader,
                    title: "Restart Mirakurun",
                    subText: "Do you want to restart Mirakurun?"
                }}
            >
                <DialogFooter>
                    <PrimaryButton
                        text="Restart"
                        onClick={() => {
                            (async () => {
                                await fetch(`/api/restart`, { method: "PUT" });
                            })();
                            setHideDialog(true);
                            setRestartRequired(false);
                        }}
                    />
                    <DefaultButton
                        text="Cancel"
                        onClick={() => setHideDialog(true)}
                    />
                </DialogFooter>
            </Dialog>
            {restartRequired && (
                <Coachmark
                    target={targetButton.current}
                    onDismiss={() => setRestartRequired(false)}
                    positioningContainerProps={{
                        directionalHint: DirectionalHint.leftCenter,
                        doNotLayer: false,
                    }}
                >
                    <TeachingBubbleContent
                        hasCloseButton
                        onDismiss={() => setRestartRequired(false)}
                    >
                        Restart is required to apply configuration.
                    </TeachingBubbleContent>
                </Coachmark>
            )}
            <div ref={targetButton}>
                <ActionButton
                    iconProps={{ iconName: "Sync" }}
                    text="Restart"
                    onClick={() => setHideDialog(false)}
                />
            </div>
        </>
    );
};

export default Restart;
