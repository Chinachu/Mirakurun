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
import { useState, useEffect } from "react";
import { Alignment, Spinner, Breadcrumbs, Navbar, NonIdealState, NonIdealStateProps, Card } from "@blueprintjs/core";
import { LazyCaller, textMatch, normalizeText } from "../modules/common";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import { Program } from "../../../api.d";

import { ProgramCardBase } from "../components/ProgramCardBase";

import "./SearchView.sass";

export const SearchView: React.FC = () => {
    console.debug("routes", "SearchView");

    const [nonIdealState, setNonIdealState] = useState<NonIdealStateProps>(null);
    const [programs, setPrograms] = useState<Program[]>(null);
    const [result, setResult] = useState<JSX.Element[]>([]);
    const [title, setTitle] = useState<string>("検索");
    // const isLoading = !programs && !error;

    const { navigate, searchParams } = state;
    const query = searchParams.get("q") || null;

    const isLoading = query && !programs;
    ui.setTitle(title, isLoading);

    useEffect(() => {
        const onPrograms = () => {
            const _programs = state.programs.filter(program => {
                // 共有イベントを除外
                if (program.relatedItems?.filter(item => item.type === "shared").length === 1) {
                    return false;
                }
                return true;
            });
            setPrograms(_programs);
        };
        const onProgramsLazy = new LazyCaller(0, 1000, onPrograms);
        state.on("programs", onProgramsLazy.caller);
        state.subscribePrograms(true);

        return () => {
            // // unsubscribe せずに差分更新を継続する
            // state.unsubscribePrograms();
            state.off("programs", onProgramsLazy.caller);
            onProgramsLazy.destroy();
        }
    }, []);

    useEffect(() => {
        if (!query) {
            setTitle("検索");
            setResult([]);
            setNonIdealState({
                icon: "search",
                title: "検索キーワードを入力してください",
                description: "番組名、番組説明、サービス名、ジャンルなどで検索できます"
            });
            return;
        }

        if (!programs) {
            setTitle("検索...");
            setNonIdealState({
                icon: <Spinner />,
                title: "ロード中",
                description: "番組一覧を読み込んでいます..."
            });
            return;
        }

        const q = normalizeText(query.trim()).toLowerCase();
        const filteredPrograms: Program[] = [];

        for (const p of programs) {
            if (
                (p.name && textMatch(p.name, q)) ||
                (p.description && textMatch(p.description, q)) ||
                (p.extended && textMatch(Object.entries(p.extended).flat().join(" "), q))
            ) {
                filteredPrograms.push(p);
                continue;
            }
        }

        filteredPrograms.sort((a, b) => {
            return a.startAt - b.startAt;
        });

        const _result: JSX.Element[] = filteredPrograms.map(createResultItem);

        setTitle(`検索 "${query}" (${_result.length}件)`);
        setResult(_result);
        setNonIdealState(null);

        return () => {
            setNonIdealState(null);
        };
    }, [programs, query]);

    return (
        <div className="route" id="route-search-view">
            <Navbar className="toolbar">
                <Navbar.Group align={Alignment.START}>
                    <Navbar.Heading>
                        <Breadcrumbs items={[
                            {
                                text: "EPG",
                                onClick: () => navigate("/epg")
                            },
                            {
                                text: "検索",
                                className: `heading-title ${isLoading ? "bp5-skeleton" : ""}`.trim(),
                            }
                        ]} />
                    </Navbar.Heading>
                </Navbar.Group>

                <Navbar.Group align={Alignment.END}>
                </Navbar.Group>
            </Navbar>

            <div className="content">
                {!nonIdealState && result}

                {nonIdealState && <>
                    <NonIdealState {...nonIdealState} />
                </>}
            </div>
        </div>
    );
};

function createResultItem(program: Program) {
    return (
        <Card key={program.id} elevation={0}>
            <ProgramCardBase
                program={program}
                noAVInfo={true}
                noActions={true}
            />
        </Card>
    );
}
