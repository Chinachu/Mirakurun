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
import * as common from "./common";
import _ from "./_";
import * as apid from "../../api";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import type { StreamLocation } from "./Channel";
import type { StreamTarget } from "./Tuner";

export default class ServiceItem {
    static getId(networkId: number, serviceId: number): number {
        return parseInt(networkId + (serviceId / 100000).toFixed(5).slice(2), 10);
    }

    private _id: number;
    private _order: number;

    constructor(
        private _channel: ChannelItem,
        private _networkId: number,
        private _serviceId: number,
        private _name?: string,
        private _type?: number,
        private _logoId?: number,
        private _remoteControlKeyId?: number,
        private _epgReady: boolean = false,
        private _epgUpdatedAt: number = 0,
        private _streamId?: number
    ) {
        this._id = ServiceItem.getId(_networkId, _serviceId);
    }

    get id(): number {
        return this._id;
    }

    get networkId(): number {
        return this._networkId;
    }

    get serviceId(): number {
        return this._serviceId;
    }

    get name(): string {
        return this._name || "";
    }

    set name(name: string) {
        if (this._name !== name) {
            this._name = name;

            _.service.save();
            this._updated();
        }
    }

    get type(): number {
        return this._type;
    }

    set type(type: number) {
        if (this._type !== type) {
            this._type = type;

            _.service.save();
            this._updated();
        }
    }

    get logoId(): number {
        return this._logoId;
    }

    set logoId(logoId: number) {
        if (this._logoId !== logoId) {
            this._logoId = logoId;

            _.service.save();
            this._updated();
        }
    }

    get remoteControlKeyId(): number {
        return this._remoteControlKeyId;
    }

    set remoteControlKeyId(id: number) {
        if (this._remoteControlKeyId !== id) {
            this._remoteControlKeyId = id;
            this._order = undefined;

            _.service.save();
            this._updated();
        }
    }

    get epgReady(): boolean {
        return this._epgReady;
    }

    set epgReady(epgReady: boolean) {
        if (this._epgReady !== epgReady) {
            this._epgReady = epgReady;

            _.service.save();
            this._updated();
        }
    }

    get epgUpdatedAt(): number {
        return this._epgUpdatedAt;
    }

    set epgUpdatedAt(time: number) {
        if (this._epgUpdatedAt !== time) {
            this._epgUpdatedAt = time;

            _.service.save();
            this._updated();
        }
    }

    /** `undefined` until the service is scanned (e.g. migrated from the db of older versions) */
    get streamId(): number {
        return this._streamId;
    }

    set streamId(streamId: number) {
        if (this._streamId !== streamId) {
            this._streamId = streamId;
            _.service.invalidateChannelIndex?.();

            _.service.save();
            this._updated();
        }
    }

    get channel(): ChannelItem {
        return this.channels[0];
    }

    /** channels carrying the stream of the service, the channel scanned the service comes first. */
    get channels(): ChannelItem[] {
        return [...new Set(this.locations.map(location => location.channel))];
    }

    /**
     * the channels and the streams (the relative streams of TSMF) carrying the stream of the service.
     * `stream` is `null` until the stream is received on the channel.
     */
    get locations(): StreamLocation[] {
        const locations: StreamLocation[] = [];

        // until the stream is received on the channel, it is trusted as before
        const streams = this._channel.streams;
        if (this._streamId === undefined || streams.length === 0) {
            locations.push({ channel: this._channel, stream: null });
        }

        if (this._streamId !== undefined) {
            const found = _.channel.findStreamLocations(this._networkId, this._streamId);
            // the channel scanned the service comes first
            locations.push(...found.filter(location => location.channel === this._channel));
            locations.push(...found.filter(location => location.channel !== this._channel));
        }

        // the stream has moved from the channel but not found elsewhere yet
        if (locations.length === 0) {
            locations.push({ channel: this._channel, stream: null });
        }

        return locations;
    }

    /** the channels and the relative streams of TSMF to receive the service, the channel scanned the service comes first. */
    get targets(): StreamTarget[] {
        return this.locations.map(({ channel, stream }) => ({ channel, relTs: stream ? stream.relTs : channel.defaultRelTs }));
    }

    /** the format of the stream carrying the service */
    get format(): apid.StreamFormat {
        const location = this.locations[0];
        return location.channel.getFormat(location.stream?.relTs);
    }

    get isTlv(): boolean {
        return this.format === "tlv";
    }

    export(): apid.Service {
        const channels = this.channels;
        const channel = channels[0];
        const ret: apid.Service = {
            id: this._id,
            serviceId: this._serviceId,
            networkId: this._networkId,
            name: this._name || "",
            type: this._type,
            logoId: this._logoId,
            remoteControlKeyId: this._remoteControlKeyId,
            epgReady: this._epgReady,
            epgUpdatedAt: this._epgUpdatedAt,
            streamId: this._streamId,
            channel: {
                type: channel.type,
                channel: channel.channel,
                route: channel.route
            },
            channels: channels.map(channel => ({
                type: channel.type,
                channel: channel.channel,
                route: channel.route
            }))
        };

        return ret;
    }

    getStream(userRequest: common.UserRequest, output: stream.Writable): Promise<common.StreamFilter> {
        return _.tuner.initServiceStream(this, userRequest, output);
    }

    getOrder(): number {
        if (this._order !== undefined) {
            return this._order;
        }
        let order: string;

        switch (this._channel.type) {
            case "GR":
                order = "1";
                break;
            case "BS":
                order = "2";
                break;
            case "CS":
                order = "3";
                break;
            case "SKY":
                order = "4";
                break;
            case "BS4K":
                order = "5";
                break;
        }

        if (this._remoteControlKeyId) {
            order += (100 + this._remoteControlKeyId).toString(10);
        } else {
            order += "200";
        }

        order += (10000 + this._serviceId).toString(10);

        return this._order = parseInt(order, 10);
    }

    private _updated(): void {
        Event.emit("service", "update", this.export());
    }
}
