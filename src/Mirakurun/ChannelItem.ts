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

export interface ChannelStream {
    readonly networkId: number;
    /** transport_stream_id (or tlv_stream_id) */
    readonly streamId: number;
    /** detected by the service scan */
    readonly format?: apid.StreamFormat;
    /** TSMF: the relative stream number */
    readonly relTs?: number;
    /** TSMF: the slots of the relative stream in a frame */
    readonly slots?: number;
}

export default class ChannelItem {
    readonly name: string;
    readonly type: apid.ChannelType;
    readonly route: apid.ChannelRoute;
    readonly channel: string;
    readonly tsmfRelTs: number;
    readonly commandVars: apid.ConfigChannelsItem["commandVars"];
    private _format: apid.StreamFormat;

    constructor(config: apid.ConfigChannelsItem) {
        this.name = config.name;
        this.type = config.type;
        this.route = config.route || common.getDefaultChannelRoute(config.type);
        this.channel = config.channel;
        this.tsmfRelTs = config.tsmfRelTs;
        this.commandVars = config.commandVars;
        this._format = config.format;
    }

    /** the streams received last time (the relative streams of TSMF). `[]` until received once. */
    get streams(): ChannelStream[] {
        return _.channel.getStreams(this);
    }

    /** the stream of `defaultRelTs`. `null` until received once. */
    get stream(): ChannelStream {
        return this.getStreamByRelTs(this.defaultRelTs);
    }

    /**
     * the relative stream of TSMF without specifying: `tsmfRelTs` of channels.yml, or the one of the most slots (the smaller number if the same)
     * (`undefined` if not TSMF or not received yet)
     */
    get defaultRelTs(): number {
        if (this.tsmfRelTs) {
            return this.tsmfRelTs;
        }
        let picked: ChannelStream = null;
        for (const stream of this.streams) {
            if (stream.relTs !== undefined && (picked === null || stream.slots > picked.slots || (stream.slots === picked.slots && stream.relTs < picked.relTs))) {
                picked = stream;
            }
        }
        return picked?.relTs;
    }

    /**
     * `format` of channels.yml, the format detected by the service scan, or the default of the type (TLV for `BS4K`).
     * The streams use this without detecting (not to delay the streams of TS).
     */
    get format(): apid.StreamFormat {
        return this.getFormat(this.defaultRelTs);
    }

    get isTlv(): boolean {
        return this.format === "tlv";
    }

    /** @param relTs the relative stream of TSMF */
    getStreamByRelTs(relTs?: number): ChannelStream {
        return this.streams.find(stream => stream.relTs === relTs) || null;
    }

    /** @param relTs the relative stream of TSMF */
    getFormat(relTs?: number): apid.StreamFormat {
        return this._format || this.getStreamByRelTs(relTs)?.format || (common.tlvChannelTypes.includes(this.type) ? "tlv" : "ts");
    }

    /** @param format detected by the service scan, keeps the last one if omitted */
    setStream(networkId: number, streamId: number, format?: apid.StreamFormat): void {
        const last = this.getStreamByRelTs(this.tsmfRelTs || undefined);
        const isSame = last !== null && last.networkId === networkId && last.streamId === streamId;
        this.setStreams([{
            networkId,
            streamId,
            format: format || (isSame ? last.format : undefined),
            ...(this.tsmfRelTs && { relTs: this.tsmfRelTs })
        }]);
    }

    /** the streams received by the service scan (all the relative streams of TSMF) */
    setStreams(streams: ChannelStream[]): void {
        _.channel.setStreams(this, streams);
    }

    toJSON(): apid.ConfigChannelsItem {
        return {
            name: this.name,
            type: this.type,
            channel: this.channel,
            route: this.route,
            tsmfRelTs: this.tsmfRelTs,
            format: this._format,
            commandVars: this.commandVars
        };
    }

    getServices(): ServiceItem[] {
        return _.service.findByChannel(this);
    }

    getStream(user: common.User, output: stream.Writable): Promise<common.StreamFilter> {
        return _.tuner.initChannelStream(this, user, output);
    }
}
