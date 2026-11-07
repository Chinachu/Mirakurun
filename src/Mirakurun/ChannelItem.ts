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
    readonly groupId?: number;
    readonly numberOfCarriers?: number;
    readonly carrierSequence?: number;
}

export default class ChannelItem {
    readonly name: string;
    readonly type: apid.ChannelType;
    readonly route: apid.ChannelRoute;
    readonly channel: string;
    readonly tsmfRelTs: number;
    readonly commandVars: apid.ConfigChannelsItem["commandVars"];
    private _configuredTsmfGroupId: number;
    private _format: apid.StreamFormat;
    /** as configured (for the output) */
    private _configuredTsmfRelTs: number;

    constructor(config: apid.ConfigChannelsItem) {
        this.name = config.name;
        this.type = config.type;
        this.route = config.route || common.getDefaultChannelRoute(config.type);
        this.channel = config.channel;
        // `0` or empty is not specified
        this.tsmfRelTs = config.tsmfRelTs || undefined;
        this._configuredTsmfRelTs = config.tsmfRelTs;
        this._configuredTsmfGroupId = config.tsmfGroupId;
        this.commandVars = config.commandVars;
        this._format = config.format;
    }

    get tsmfGroupId(): number {
        // the group discovered may be 0 (`tsmfGroupId` configured is 1 to 255)
        return this._configuredTsmfGroupId ?? this.streams.find(stream => stream.groupId !== undefined)?.groupId;
    }

    /** the streams received last time (the relative streams of TSMF). `[]` until received once. */
    get streams(): ChannelStream[] {
        return _.channel.getStreams(this);
    }

    /** the stream of `tsmfRelTs` (the stream as received if not specified). `null` until received once. */
    get stream(): ChannelStream {
        return this.getStreamByRelTs(this.tsmfRelTs || undefined);
    }

    /**
     * the relative stream of TSMF without specifying: `tsmfRelTs` of channels.yml, or the one of the most slots (the smaller number if the same)
     * (`undefined` if not TSMF or not received yet)
     */
    get defaultRelTs(): number {
        return this.getDefaultRelTs();
    }

    /**
     * `format` of channels.yml, the format detected by the service scan, or the default of the type (TLV for `BS4K`).
     * The streams use this without detecting (not to delay the streams of TS).
     * (the format of `tsmfRelTs`, or of the stream as received if not specified)
     */
    get format(): apid.StreamFormat {
        return this.getFormat(this.tsmfRelTs || undefined);
    }

    get isTlv(): boolean {
        return this.format === "tlv";
    }

    /** @param networkId the relative streams of the network come first (for the service not received on the channel yet) */
    getDefaultRelTs(networkId?: number): number {
        if (this.tsmfRelTs) {
            return this.tsmfRelTs;
        }
        const streams = this.streams.filter(stream => stream.relTs !== undefined);
        const ofNetwork = streams.filter(stream => stream.networkId === networkId);
        let picked: ChannelStream = null;
        for (const stream of ofNetwork.length > 0 ? ofNetwork : streams) {
            if (picked === null || stream.slots > picked.slots || (stream.slots === picked.slots && stream.relTs < picked.relTs)) {
                picked = stream;
            }
        }
        return picked?.relTs;
    }

    /** @param relTs the relative stream of TSMF */
    getStreamByRelTs(relTs?: number): ChannelStream {
        return this.streams.find(stream => stream.relTs === relTs) || null;
    }

    /**
     * `format` of channels.yml is for the stream of the channel (`tsmfRelTs`, or the stream as received),
     * the relative streams of TSMF detected use the formats detected
     * @param relTs the relative stream of TSMF
     */
    getFormat(relTs?: number): apid.StreamFormat {
        const isChannelStream = relTs === (this.tsmfRelTs || undefined);
        if (this._format && isChannelStream) {
            return this._format;
        }
        const format = this.getStreamByRelTs(relTs)?.format;
        if (format) {
            return format;
        }
        // TSMF is TS outside
        if (relTs === undefined && this.streams.some(stream => stream.relTs !== undefined)) {
            return "ts";
        }
        return this._format || (common.tlvChannelTypes.includes(this.type) ? "tlv" : "ts");
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
            tsmfRelTs: this._configuredTsmfRelTs,
            format: this._format,
            tsmfGroupId: this._configuredTsmfGroupId,
            commandVars: this.commandVars
        };
    }

    /** the channels of the bonded carriers including this, `null` if not bonded */
    getBondedChannels(): ChannelItem[] | null {
        if (this.tsmfGroupId === undefined) {
            return null;
        }
        // configured: the channels configured with the same group (the groups discovered are not mixed)
        if (this._configuredTsmfGroupId !== undefined) {
            return _.channel.items.filter(item => item.type === this.type && item._configuredTsmfGroupId === this._configuredTsmfGroupId);
        }
        // discovered: the channels of the same route carrying the same TLV in the same group
        return _.channel.items.filter(item => item.type === this.type && item.route === this.route &&
            item._configuredTsmfGroupId === undefined && item.tsmfGroupId === this.tsmfGroupId &&
            this.streams.some(stream => stream.format === "tlv" &&
                item.streams.some(other => other.format === "tlv" && other.networkId === stream.networkId && other.streamId === stream.streamId &&
                    other.relTs === stream.relTs && other.numberOfCarriers === stream.numberOfCarriers)));
    }

    /**
     * whether all the carriers of the group discovered (`stream` of TLV of this channel) are known
     * (the number of the carriers with the consecutive carrier_sequence from 0 or 1)
     */
    hasAllCarriers(stream: ChannelStream): boolean {
        const carriers = this.getBondedChannels() || [];
        const sequences = carriers.map(item => item.streams.find(other => other.format === "tlv" &&
            other.networkId === stream.networkId && other.streamId === stream.streamId)?.carrierSequence);
        const ordered = [...sequences].sort((a, b) => a - b);
        return stream.groupId !== undefined && carriers.length === stream.numberOfCarriers && new Set(sequences).size === stream.numberOfCarriers &&
            ordered.every((sequence, i) => sequence === i + ordered[0]) && (ordered[0] === 0 || ordered[0] === 1);
    }

    getServices(): ServiceItem[] {
        return _.service.findByChannel(this);
    }

    getStream(user: common.User, output: stream.Writable): Promise<common.StreamFilter> {
        return _.tuner.initChannelStream(this, user, output);
    }
}
