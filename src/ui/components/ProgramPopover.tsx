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
import { useEffect, useState } from "react";
import { Popover, PopoverTargetProps } from "@blueprintjs/core";
import { Program } from "../../../api.d";

import { ProgramCardBase } from "./ProgramCardBase";

import "./ProgramPopover.sass";

type ProgramPopoverProps<T = {}> = {
    program: Program;
    key?: string;
    className?: string;
    portalContainer?: HTMLElement;
    defaultIsOpen?: boolean;
    renderTarget: (props: PopoverTargetProps & T) => JSX.Element;
};
export const ProgramPopover: React.FC<ProgramPopoverProps> = ({ program, renderTarget, className = "", defaultIsOpen = false, ...props }) => {
    // console.debug("components", "ProgramPopover");

    const [active, setActive] = useState(defaultIsOpen);
    const [content, setContent] = useState<React.JSX.Element>(null);

    useEffect(() => {
        if (!active) {
            return;
        }

        setContent(<ProgramCardBase program={program} />);

        return () => {
            setContent(null);
        };
    }, [active]);

    if (className) {
        className += " ";
    }
    className += "bp5-dark";

    return (
        <Popover {...props}
            className={className}
            renderTarget={renderTarget}
            defaultIsOpen={active}
            onOpening={() => setActive(true)}
            onClosed={() => setActive(false)}
            content={
                <div className="component-program-popover">
                    {content}
                </div>
            }
        />
    );
};
