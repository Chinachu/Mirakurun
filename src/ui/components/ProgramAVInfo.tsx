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
