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
import { Button, Dialog, DialogBody, DialogFooter } from "@blueprintjs/core";

export const Restart: React.FC<{
    isOpen: boolean;
    onClose: () => void;
}> = ({ isOpen, onClose }) => {
    const handleRestart = async () => {
        await fetch("/api/restart", { method: "PUT" });
        onClose();
    };

    return (
        <Dialog
            isOpen={isOpen}
            onClose={onClose}
            title="Restart Mirakurun"
            canEscapeKeyClose
        >
            <DialogBody>
                <div>
                    Do you want to restart Mirakurun?
                </div>
            </DialogBody>
            <DialogFooter
                actions={
                    <>
                        <Button text="Cancel" onClick={onClose} />
                        <Button text="Restart" intent="danger" onClick={handleRestart} />
                    </>
                }
            />
        </Dialog>
    );
};
