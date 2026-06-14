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
import { useState, useEffect, useMemo } from "react";
import { Section } from "@blueprintjs/core";
import { relatedItemTypeMap, relatedItemTypeIconMap } from "../modules/constants";
import { state } from "../modules/state";
import { Program } from "../../../api.d";

import { ProgramCardBase } from "./ProgramCardBase";

import "./ProgramRelatedLinks.sass";

type ProgramRelatedLinksProps = {
    program: Program;
};
export const ProgramRelatedLinks: React.FC<ProgramRelatedLinksProps> = ({ program }) => {
    console.debug("components", "ProgramRelatedLinks");

    const [links, setLinks] = useState<React.JSX.Element[]>([]);

    const relatedItems = useMemo(() => {
        return program?.relatedItems?.filter(item => {
            if (item.networkId) {
                return item.eventId !== program.eventId || item.serviceId !== program.serviceId || item.networkId !== program.networkId;
            }
            return item.eventId !== program.eventId || item.serviceId !== program.serviceId;
        });
    }, [program]);

    useEffect(() => {
        if (!relatedItems || relatedItems.length === 0) {
            setLinks([]);
            return;
        }

        console.debug("ProgramRelatedLinks", "relatedItems", relatedItems);

        let abort = false;

        (async () => {
            const _links: React.JSX.Element[] = [];
            const programs = state.programs.length > 0 ? state.programs : await state.fetchPrograms();

            if (abort) {
                return;
            }

            for (const item of relatedItems) {
                const p = programs.find(p => {
                    if (item.networkId) {
                        return p.eventId === item.eventId && p.serviceId === item.serviceId && p.networkId === item.networkId;
                    }
                    return p.eventId === item.eventId && p.serviceId === item.serviceId;
                });
                if (!p) {
                    continue;
                }

                const link = (
                    <Section
                        key={`${item.type}-${item.eventId}-${item.serviceId}`}
                        className={`related-item-type-${item.type}`}
                        icon={relatedItemTypeIconMap[item.type]}
                        title={relatedItemTypeMap[item.type]}
                        compact
                    >
                        <ProgramCardBase program={p} />
                    </Section>
                );
                _links.push(link);
            }

            setLinks(_links);
        })();

        return () => {
            abort = true;
        }
    }, [relatedItems]);

    if (links.length === 0) {
        return <></>;
    }

    return (
        <div className="component-program-related-links">
            {links}
        </div>
    );
};
