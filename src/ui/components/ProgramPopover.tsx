import * as React from "react";
import { useEffect, useState } from "react";
import { Popover, PopoverTargetProps } from "@blueprintjs/core";
import { Program } from "../../../api.d";

import { ProgramCardBase } from "./ProgramCardBase";

import "./ProgramPopover.sass";

type ProgramPopoverProps<T = Element> = {
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
