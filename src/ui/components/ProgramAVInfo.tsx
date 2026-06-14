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
import { langMap, audioModeMap } from "../modules/constants";
import { ProgramVideo, ProgramAudio } from "../../../api.d";;

import "./ProgramAVInfo.sass";

type ProgramAVInfoProps = {
    video: ProgramVideo;
    audios: ProgramAudio[];
};
export const ProgramAVInfo: React.FC<ProgramAVInfoProps> = ({ video, audios }) => {
    // console.debug("components", "ProgramAVInfo");

    const labels: JSX.Element[] = [];

    if (video) {
        if (video.type !== "mpeg2") {
            labels.push(<span key="video.type" className="video type">{video.type}</span>);
        }
        labels.push(<span key="video.resolution" className="video resolution">{video.resolution}</span>);
    }

    if (audios) {
        let count = 0;
        for (const audio of audios) {
            const trackPrefix = count === 0 ? "主" : "副";
            const type8 = audio.componentType.toString(2).padStart(8, "0");

            const mode = audioModeMap[type8.slice(-5)] || "不明なモード";
            const lang = audio.langs.map(lang => langMap[lang]).join("＋");

            labels.push(
                <span key={`audios.${count}`} className="audio">
                    {audios.length > 1 && <>{trackPrefix}:&nbsp;</>}
                    {mode}
                    {lang !== "日本語" && <>&nbsp;/&nbsp;{lang}</>}
                </span>
            );
            count++;
        }
    }

    return (
        <div className="component-program-av-info">
            {labels}
        </div>
    );
};
