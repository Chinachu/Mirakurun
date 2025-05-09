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
