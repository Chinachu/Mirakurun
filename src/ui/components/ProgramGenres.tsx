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
import { Genre1Map, Genre2Map, GenreUN1Map, GenreUN2Map } from "../modules/constants";
import { ProgramGenre } from "../../../api.d";

import "./ProgramGenres.sass";

type ProgramGenresProps = {
    genres: ProgramGenre[];
};
export const ProgramGenres: React.FC<ProgramGenresProps> = ({ genres }) => {
    // console.debug("components", "ProgramGenres");

    const lv1Set = new Set<number>();
    const labels: JSX.Element[] = [];
    for (const genre of genres) {
        const lv1Text = Genre1Map[genre.lv1];
        if (!lv1Text) {
            continue;
        }

        const un2Text = GenreUN2Map[(genre.lv1 * 0x1000) + (genre.lv2 * 0x100) + (genre.un1 * 0x10) + genre.un2];
        if (un2Text) {
            const key = (genre.lv1 * 0x1000) + (genre.lv2 * 0x100) + (genre.un1 * 0x10) + genre.un2;
            if (key < 0xE000 || key > 0xE020) {
                continue;
            }
            labels.push(<span key={key} className="caution">{un2Text}</span>);
            continue;
        }

        if (!lv1Set.has(genre.lv1)) {
            lv1Set.add(genre.lv1);
            labels.push(<span key={genre.lv1} className={`bg-genre-lv1-${genre.lv1}`}>{lv1Text}</span>);
        }

        const lv2Text = Genre2Map[(genre.lv1 * 0x10) + genre.lv2];
        labels.push(<span key={`${genre.lv1}.${genre.lv2}`} className={`bg-genre-lv1-${genre.lv1}`}>{lv2Text}</span>);
    }

    return (
        <div className="component-program-genres">
            {labels}
        </div>
    );
};
