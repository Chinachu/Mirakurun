import * as React from "react";
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { channelTypeMap } from "../modules/constants";
import { Service } from "../../../api.d";
import { state } from "../modules/state";

import "./ServiceLink.sass";

type ServiceLinkProps = {
    globalId: number;
    date?: string;
    time?: number;
} & React.HTMLAttributes<HTMLDivElement>;
export const ServiceLink: React.FC<ServiceLinkProps> = ({ globalId, date, time, ...props }) => {
    console.debug("components", "ServiceLink");

    const [service, setService] = useState<Service>(null);

    useEffect(() => {
        (async () => {
            const _service = state.services.find(s => s.id === globalId);
            setService(_service);
        })();

        return () => {
            setService(null);
        };
    }, [globalId]);

    let to = "#";
    let className = "component-service-link";

    if (props.className) {
        className += ` ${props.className}`;
    }

    if (service) {
        to = `/epg/services/${service.id}`;
        if (date && time) {
            to += `?date=${date}&time=${time}`
        } else if (time) {
            to += `?time=${time}`
        } else if (date) {
            to += `?date=${date}`
        }
    }

    return (
        <div className={className} {...props}>
            {service && service.hasLogoData && <img src={`/api/services/${service.id}/logo`} />}

            <Link className={service ? null : "bp5-skeleton"} title="EPG 番組表 (週間)" to={to}>
                {service ? `${service.name.normalize("NFKC")} (${channelTypeMap[service.channel.type]})` : "サービス名..."}
            </Link>
        </div>
    );
};
