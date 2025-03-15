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
import * as React from "react";
import { useState, useEffect } from "react";
import {
    MessageBar,
    MessageBarType,
    MessageBarButton,
    Link
} from "@fluentui/react";
import { Version } from "../../../api";

const UpdateAlert: React.FC = () => {
    const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
    const [version, setVersion] = useState<Version>(null);

    useEffect(() => {
        setTimeout(async () => {
            console.log("UpdateAlert", "checking update", "...");
            const version: Version = await (await fetch("/api/version")).json();
            setVersion(version);
            if (version.current !== version.latest) {
                setUpdateAvailable(true);
            }
            console.log("UpdateAlert", "checking update", "done.");
        }, 1000 * 5);
    }, []);

    return (
        <>
            {updateAvailable === true && (
                <MessageBar
                    messageBarType={MessageBarType.warning}
                    isMultiline={false}
                    onDismiss={() => setUpdateAvailable(false)}
                    dismissButtonAriaLabel="Close"
                    actions={
                        <div>
                            <MessageBarButton
                                href="https://github.com/Chinachu/Mirakurun/blob/master/doc/Platforms.md"
                                target="_blank"
                            >
                                How to Update
                            </MessageBarButton>
                        </div>
                    }
                >
                    Update ({version.latest}) Available!
                    <Link href="https://github.com/Chinachu/Mirakurun/blob/master/CHANGELOG.md" target="_blank">
                        CHANGELOG
                    </Link>
                </MessageBar>
            )}
        </>
    );
};

export default UpdateAlert;
