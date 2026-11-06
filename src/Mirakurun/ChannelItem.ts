/*
   Copyright 2016 kanreisa

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
import * as stream from "stream";
import _ from "./_";
import * as common from "./common";
import * as apid from "../../api";
import ServiceItem from "./ServiceItem";
import TSFilter from "./TSFilter";

export interface ChannelStream {
    readonly networkId: number;
    /** transport_stream_id */
    readonly streamId: number;
}

export default class ChannelItem {
    readonly name: string;
    readonly type: apid.ChannelType;
    readonly route: apid.ChannelRoute;
    readonly channel: string;
    readonly tsmfRelTs: number;
    readonly commandVars: apid.ConfigChannelsItem["commandVars"];

    constructor(config: apid.ConfigChannelsItem) {
        this.name = config.name;
        this.type = config.type;
        this.route = config.route || common.getDefaultChannelRoute(config.type);
        this.channel = config.channel;
        this.tsmfRelTs = config.tsmfRelTs;
        this.commandVars = config.commandVars;
    }

    /** the stream received last time. `null` until received once. */
    get stream(): ChannelStream {
        return _.channel.getStream(this);
    }

    setStream(networkId: number, streamId: number): void {
        _.channel.setStream(this, networkId, streamId);
    }

    toJSON(): apid.ConfigChannelsItem {
        return {
            name: this.name,
            type: this.type,
            channel: this.channel,
            route: this.route,
            tsmfRelTs: this.tsmfRelTs,
            commandVars: this.commandVars
        };
    }

    getServices(): ServiceItem[] {
        return _.service.findByChannel(this);
    }

    getStream(user: common.User, output: stream.Writable): Promise<TSFilter> {
        return _.tuner.initChannelStream(this, user, output);
    }
}
