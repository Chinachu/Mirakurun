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
import * as common from "./common";
import * as log from "./log";
import * as apid from "../../api";
import _ from "./_";
import * as db from "./db";
import status from "./status";
import ChannelItem, { ChannelStream } from "./ChannelItem";
import type ServiceItem from "./ServiceItem";
import { JobItem } from "./Job";

export interface StreamLocation {
    channel: ChannelItem;
    /** `null` until the stream is received on the channel */
    stream: ChannelStream | null;
}

export class Channel {
    private _items: ChannelItem[] = [];
    private _startup: boolean = true;
    private _saveTimerId: NodeJS.Timeout;
    private _streams = new Map<ChannelItem, ChannelStream[]>();
    /** <networkId, <streamId, the channels and the streams>> */
    private _streamIndex: Map<number, Map<number, StreamLocation[]>> = null;

    constructor() {
        this._load();

        if (_.config.server.disableEITParsing !== true) {
            const epgJob: JobItem = {
                key: "EPG.Gatherer",
                name: "EPG Gatherer",
                fn: () => this._epgGatherer()
            };

            _.job.add({
                ...epgJob,
                readyFn: async () => {
                    await common.sleep(1000 * 60);
                    return true;
                }
            });

            _.job.addSchedule({
                key: epgJob.key,
                schedule: _.config.server.epgGatheringJobSchedule || "20,50 * * * *",
                job: epgJob
            });
        }
    }

    get items(): ChannelItem[] {
        return this._items;
    }

    add(item: ChannelItem): void {
        if (this.get(item.type, item.channel) === null) {
            this._items.push(item);
            this._streamIndex = null;
            _.service?.invalidateChannelIndex?.();
        }
    }

    get(type: apid.ChannelType, channel: string): ChannelItem {
        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].channel === channel && this._items[i].type === type) {
                return this._items[i];
            }
        }

        return null;
    }

    findByType(type: apid.ChannelType): ChannelItem[] {
        const items = [];

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].type === type) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    /** channels received the stream last time */
    findByStream(networkId: number, streamId: number): ChannelItem[] {
        return [...new Set(this.findStreamLocations(networkId, streamId).map(location => location.channel))];
    }

    /** the channels and the streams (the relative streams of TSMF) received the stream last time */
    findStreamLocations(networkId: number, streamId: number): StreamLocation[] {
        if (this._streamIndex === null) {
            this._streamIndex = new Map();
            for (const item of this._items) {
                for (const stream of this._streams.get(item) || []) {
                    let streams = this._streamIndex.get(stream.networkId);
                    if (!streams) {
                        streams = new Map();
                        this._streamIndex.set(stream.networkId, streams);
                    }
                    let locations = streams.get(stream.streamId);
                    if (!locations) {
                        locations = [];
                        streams.set(stream.streamId, locations);
                    }
                    locations.push({ channel: item, stream });
                }
            }
        }

        return this._streamIndex.get(networkId)?.get(streamId) || [];
    }

    getStreams(item: ChannelItem): ChannelStream[] {
        return this._streams.get(item) || [];
    }

    setStreams(item: ChannelItem, streams: ChannelStream[]): void {
        if (JSON.stringify(this._streams.get(item) || []) === JSON.stringify(streams)) {
            return;
        }
        this._streams.set(item, streams);
        this._streamIndex = null;
        _.service?.invalidateChannelIndex?.();

        this.save();
    }

    save(): void {
        clearTimeout(this._saveTimerId);
        this._saveTimerId = setTimeout(() => this._save(), 1000 * 10);
    }

    async load(): Promise<void> {
        log.debug("loading channels db...");

        const channels = await db.loadChannels(_.configIntegrity.channels, true);
        for (const channel of channels) {
            const item = this.get(channel.type, channel.channel);
            if (item === null) {
                continue;
            }
            // the format before the relative streams of TSMF (the stream of the channel, of `tsmfRelTs` if specified)
            const legacy = channel as unknown as db.ChannelStream;
            const streams = Array.isArray(channel.streams) ? channel.streams : [{ ...legacy, relTs: item.tsmfRelTs || undefined }];
            item.setStreams(streams
                .filter(stream => typeof stream.networkId === "number" && typeof stream.streamId === "number")
                .map(stream => ({
                    networkId: stream.networkId,
                    streamId: stream.streamId,
                    ...((stream.format === "ts" || stream.format === "tlv") && { format: stream.format }),
                    ...(typeof stream.relTs === "number" && { relTs: stream.relTs }),
                    ...(typeof stream.slots === "number" && { slots: stream.slots })
                })));
        }
        // nothing changed by loading
        clearTimeout(this._saveTimerId);
    }

    private _save(): void {
        log.debug("saving channels db...");

        db.saveChannels(
            this._items
                .filter(item => this.getStreams(item).length > 0)
                .map(item => ({ type: item.type, channel: item.channel, streams: this.getStreams(item) })),
            _.configIntegrity.channels
        );
    }

    private _load(): void {
        log.debug("loading channels...");

        const channels = _.config.channels;

        channels.forEach((channel, i) => {
            if (typeof channel.name !== "string") {
                log.error("invalid type of property `name` in channel#%d configuration", i);
                return;
            }

            if (common.channelTypes.includes(channel.type) === false) {
                log.error("invalid type of property `type` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (typeof channel.channel !== "string") {
                log.error("invalid type of property `channel` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.format !== undefined && channel.format !== "ts" && channel.format !== "tlv") {
                log.error("invalid type of property `format` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.route !== undefined && common.channelRoutes.includes(channel.route) === false) {
                log.error("invalid type of property `route` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.serviceId && typeof channel.serviceId !== "number") {
                log.error("invalid type of property `serviceId` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.tsmfRelTs && typeof channel.tsmfRelTs !== "number") {
                log.error("invalid type of property `tsmfRelTs` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.commandVars && typeof channel.commandVars !== "object") {
                log.error("invalid type of property `commandVars` in channel#%d (%s) configuration", i, channel.name);
                return;
            }
            if (!channel.commandVars) {
                channel.commandVars = {};
            }
            if (channel.satelite && !channel.satellite) {
                log.warn("renaming deprecated property name `satelite` to `satellite` in channel#%d (%s) configuration", i, channel.name);
                (<any> channel).satellite = channel.satelite;
            }
            if (channel.satellite) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.satellite) {
                    channel.commandVars.satellite = channel.satellite;
                }
            }
            if (channel.space) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.space) {
                    channel.commandVars.space = channel.space;
                }
            }
            if (channel.freq) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.freq) {
                    channel.commandVars.freq = channel.freq;
                }
            }
            if (channel.polarity) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.polarity) {
                    channel.commandVars.polarity = channel.polarity;
                }
            }
            for (const key in channel.commandVars) {
                if (typeof channel.commandVars[key] !== "number" && typeof channel.commandVars[key] !== "string") {
                    log.error("invalid type of property `commandVars.%s` in channel#%d (%s) configuration", key, i, channel.name);
                    delete channel.commandVars[key];
                }
            }

            if (channel.isDisabled === true) {
                return;
            }

            if (_.tuner.typeExists(channel.type, channel.route || common.getDefaultChannelRoute(channel.type)) === false) {
                return;
            }

            if (!this.get(channel.type, channel.channel)) {
                if (channel.serviceId) {
                    (<any> channel).name = `${channel.type}:${channel.channel}`;
                }
                this.add(new ChannelItem(channel));
            }
        });
    }

    private async _epgGatherer(): Promise<void> {
        const startup = this._startup;
        if (this._startup === true) {
            this._startup = false;
        }

        // EIT of TS carries the whole network, MH-EIT of TLV (MMT) carries only its own stream
        const targets = new Map<string, { label: string, networkId: number, streamId?: number, services: ServiceItem[] }>();
        for (const item of _.service.items) {
            const isTlv = item.isTlv;
            const key = isTlv ? `NID.${item.networkId}.TSID.${item.streamId}` : `NID.${item.networkId}`;
            if (!targets.has(key)) {
                targets.set(key, {
                    label: isTlv ? `Network#${item.networkId} Stream#${item.streamId}` : `Network#${item.networkId}`,
                    networkId: item.networkId,
                    streamId: isTlv ? item.streamId : undefined,
                    services: []
                });
            }
            targets.get(key).services.push(item);
        }

        for (const [key, { label, networkId, streamId, services }] of targets) {
            const service = services[0];
            const isGathering = streamId === undefined
                ? () => status.epg[networkId] === true
                : () => status.epgByStream[common.getEpgStreamKey(networkId, streamId)] === true;

            // any channel of the network can be used, the first service's ones come first
            // the channels and the relative streams of TSMF (MH-EIT of TLV needs the relative stream of the stream)
            const locations = [service, ...services].flatMap(item => item.locations);
            const channels = [...new Set(locations.map(location => location.channel))];
            if (channels.length === 0) {
                continue;
            }
            const targets = channels.map(channel => {
                const { stream } = locations.find(location => location.channel === channel);
                return { channel, relTs: stream ? stream.relTs : channel.getDefaultRelTs(networkId) };
            });
            // picked by readyFn
            let channel: ChannelItem = null;

            _.job.add({
                key: `EPG.Gather.${key}`,
                name: `EPG Gather ${label}`,
                isRerunnable: true,
                fn: async () => {
                    log.info("%s EPG gathering has started on %s/%s", label, channel.type, channel.channel);
                    try {
                        await _.tuner.getEPG(channel, undefined, targets.find(target => target.channel === channel).relTs);
                        log.info("%s EPG gathering has finished", label);
                    } catch (e) {
                        log.warn("%s EPG gathering has failed [%s]", label, e);
                        throw new Error("EPG gathering failed");
                    }
                },
                readyFn: async () => {
                    await common.sleep(100);

                    if (isGathering()) {
                        log.info("%s EPG gathering is already in progress on another stream", label);
                        return false;
                    }
                    if (service.epgReady === true) {
                        const now = Date.now();
                        if (startup && now - service.epgUpdatedAt < 1000 * 60 * 10) { // 10 mins
                            log.info("%s EPG gathering has skipped because EPG is already up to date (in 10 mins)", label);
                            return false;
                        }
                        if (now - service.epgUpdatedAt > 1000 * 60 * 60 * 12) { // 12 hours
                            log.info("%s EPG gathering is resuming forcibly because reached maximum pause time (12 hours)", label);
                            service.epgReady = false;
                        } else {
                            const isTarget = (program: { serviceId: number }) => streamId === undefined || services.some(item => item.serviceId === program.serviceId);
                            const currentPrograms = _.program.findByNetworkIdAndTime(networkId, now)
                                .filter(program => !!program.name && program.name !== "放送休止" && isTarget(program));
                            if (currentPrograms.length === 0) {
                                const networkPrograms = _.program.findByNetworkId(networkId).filter(isTarget);
                                if (networkPrograms.length > 0) {
                                    log.info("%s EPG gathering has skipped because broadcast is off", label);
                                    return false;
                                }
                                service.epgReady = false;
                            }
                        }
                    }

                    channel = await _.tuner.readyForJob(targets);
                    return channel !== null;
                }
            });
        }
    }
}

export default Channel;
