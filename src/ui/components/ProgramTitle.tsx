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
import { useMemo } from "react";
import * as regexp from "../modules/regexp";
import { ProgramAttributeMap, ProgramAttributeClassMap, ProgramAttributeNormalizationMap } from "../modules/constants";
import { state } from "../modules/state";
import { Program } from "../../../api.d";

import "./ProgramTitle.sass";

type ProgramTitleProps = {
    program: Program;
};
export const ProgramTitle: React.FC<ProgramTitleProps> = ({ program }) => {
    // console.debug("components", "ProgramTitle");

    let name = program.name;
    if (!name) {
        if (program.relatedItems) {
            const isShared = program.relatedItems.some(item => item.type === "shared");
            if (isShared) {
                name = "(イベント共有)";
            } else {
                name = "(不明)";
            }
        } else {
            name = "(未定)";
        }
    }
    name = name.replace(regexp.squaredUnicode, "").replace(regexp.legacyAttributeFormat, "");

    // `false` if the service is normally scrambled, `undefined` if unknown
    const serviceIsFree = program.isFree ? state.getService(program.networkId, program.serviceId)?.isFree : undefined;

    const attributes = useMemo(() => {
        const attrSet = new Set<keyof typeof ProgramAttributeMap>();
        const attributeSource = (program.name || "") + (program.description || "");
        if (attributeSource) {
            const items = [
                ...attributeSource.match(regexp.enclosedAttributeUnicode) || [],
                ...attributeSource.match(regexp.legacyAttributeFormat) || [],
            ];
            // 通常有料のサービスで無料の番組 (サービスが分からない場合は従来どおり BS/CS の無料の番組)
            if (program.isFree && (serviceIsFree === false || (serviceIsFree === undefined && program.networkId >= 0x01 && program.networkId <= 0x0C))) {
                items.push("無");
            }
            for (const item of items) {
                const normalized = item.replace(/[\[\]()［］]/g, "").normalize("NFKC");
                const attrKey = ProgramAttributeNormalizationMap[normalized] || normalized;
                if (ProgramAttributeMap[attrKey]) {
                    attrSet.add(attrKey as any);
                }
            }
        }
        return [...attrSet];
    }, [program.name, program.description, program.isFree, serviceIsFree]);

    const labels = useMemo(() => {
        const pre: JSX.Element[] = [];
        const post: JSX.Element[] = [];

        for (const attribute of attributes) {
            /* if (attribute === "無") {
                // 公共放送と無料放送の [無] は省略
                continue;
            } */

            const label = (
                <span key={`attribute-${attribute}`}
                    className={`attribute bg-attribute-${ProgramAttributeClassMap[attribute] || attribute}`}
                    title={ProgramAttributeMap[attribute]}>
                    {attribute}
                </span>
            );

            if (["新", "再", "終", "生"].includes(attribute)) {
                pre.push(label);
            } else {
                post.push(label);
            }
        }

        return { pre, post };
    }, [attributes]);

    return (
        <span className="component-program-title">
            {labels.pre}
            <span className="name" title={program.name}>{name}</span>
            {labels.post}
        </span>
    );
};
