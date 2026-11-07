const { describe, it, before } = require("node:test");
const assert = require("assert");
const path = require("path");
const EventEmitter = require("events");

// status.ts のタイマーでテストのプロセスが終了しなくなるため差し替える
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
require.cache[statusPath] = {
  id: statusPath,
  filename: statusPath,
  loaded: true,
  exports: { __esModule: true, default: { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: {} } }
};

const _ = require("../lib/Mirakurun/_").default;
const log = require("../lib/Mirakurun/log");
let ChannelItem;
let ServiceItem;
let Tuner;
let detectTSMFStreams;

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04C11DB7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

// TSMF の多重フレームヘッダー (streams: [relTs, slots, isTlv, streamId, networkId])
function header(streams, cc) {
  const p = Buffer.alloc(188, 0xFF);
  p[0] = 0x47;
  p[1] = 0x00;
  p[2] = 0x2F;
  p[3] = 0x10 | (cc & 0x0F);
  const payload = p.subarray(4);
  payload[0] = 0x1A;
  payload[1] = 0x86;
  payload[2] = 0x01;
  const slotMap = [];
  for (const [relTs, slots] of streams) {
    slotMap.push(...new Array(slots).fill(relTs));
  }
  while (slotMap.length < 52) {
    slotMap.push(0);
  }
  for (let i = 0; i < 52; i++) {
    const b = payload[69 + (i >> 1)];
    payload[69 + (i >> 1)] = (i & 1) === 0 ? (slotMap[i] << 4) | (b & 0x0F) : (b & 0xF0) | slotMap[i];
  }
  let streamTypeBits = 0x7FFF;
  for (const [relTs, , isTlv, streamId, networkId] of streams) {
    if (isTlv) {
      streamTypeBits &= ~(1 << (15 - relTs));
    }
    payload.writeUInt16BE(streamId, 5 + (relTs - 1) * 4);
    payload.writeUInt16BE(networkId, 7 + (relTs - 1) * 4);
  }
  payload[121] = streamTypeBits >> 7;
  payload[122] = (streamTypeBits << 1) & 0xFF;
  payload.writeUInt32BE(crc32(payload.subarray(0, 180)), 180);
  return p;
}

describe("[tsmfauto.spec] the relative streams of TSMF", () => {
  before(() => {
    for (const level of ["info", "debug", "warn", "error"]) {
      log[level] = () => {};
    }
    _.config = { server: {} };
    ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
    ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
    Tuner = require("../lib/Mirakurun/Tuner").default;
    ({ detectTSMFStreams } = require("../lib/Mirakurun/StreamFormat"));
  });

  it("reads the relative streams by 2 headers in a row, not by the frame of the channel tuned before", () => {
    const streams = [[2, 24, false, 18801, 4], [3, 24, false, 18803, 4]];
    // 前のチャンネルのヘッダーが残り、continuity_counter が飛んでから、このチャンネルのヘッダーが続く
    const data = Buffer.concat([header([[1, 52, true, 45168, 11]], 7), header(streams, 0), header(streams, 1)]);
    assert.deepStrictEqual(detectTSMFStreams(data), [
      { relTs: 2, slots: 24, format: "ts", streamId: 18801, networkId: 4 },
      { relTs: 3, slots: 24, format: "ts", streamId: 18803, networkId: 4 }
    ]);
    // TSMF but not decided by a header (packets lost), or by the headers broken (CRC)
    assert.deepStrictEqual(detectTSMFStreams(header(streams, 0)), []);
    const broken = [0, 1, 2].map(cc => {
      const p = header(streams, cc);
      p[100] ^= 0xFF;
      return p;
    });
    assert.deepStrictEqual(detectTSMFStreams(Buffer.concat(broken)), []);
    assert.strictEqual(detectTSMFStreams(Buffer.alloc(188 * 10)), null);
  });

  it("detects TS for the relative stream of stream_type TLV whose packets are not of TLV (TSMF before extended)", () => {
    const streams = [[2, 26, true, 18801, 4], [5, 26, true, 45168, 11]];
    // the slots in the order of header() (relTs 2 x 26, relTs 5 x 26)
    const slotMap = [...new Array(26).fill(2), ...new Array(26).fill(5)];
    const packet = pid => Buffer.from([0x47, pid >> 8, pid & 0xFF, 0x10, ...new Array(184).fill(0xFF)]);
    // relTs 2: TS (PID 0x100), relTs 5: TLV (PID 0x2D)
    const frame = cc => [header(streams, cc), ...slotMap.map(relTs => packet(relTs === 2 ? 0x100 : 0x2D))];
    const formats = list => list.map(({ relTs, format }) => [relTs, format]);
    assert.deepStrictEqual(formats(detectTSMFStreams(Buffer.concat([...frame(0), ...frame(1)]))), [[2, "ts"], [5, "tlv"]]);
    // a later frame without the packets lost verifies (a packet lost in the first frame)
    const lost = frame(0);
    lost.splice(3, 1);
    assert.deepStrictEqual(formats(detectTSMFStreams(Buffer.concat([...lost, ...frame(1), ...frame(2)]))), [[2, "ts"], [5, "tlv"]]);
    // the slots of the frame are of the header before it (the order of the slots of the next header may differ)
    const reversed = [streams[1], streams[0]];
    assert.deepStrictEqual(formats(detectTSMFStreams(Buffer.concat([...frame(0), header(reversed, 1)]))), [[2, "ts"], [5, "tlv"]]);
    // the packets lost (or the slots empty) do not decide
    assert.deepStrictEqual(formats(detectTSMFStreams(Buffer.concat([header(streams, 0), header(streams, 1)]))), [[2, "tlv"], [5, "tlv"]]);
  });

  it("treats tsmfRelTs of 0 or empty as not specified (outputs it as configured)", () => {
    _.channel = { getStreams: () => [] };
    for (const tsmfRelTs of [0, null]) {
      const channel = new ChannelItem({ name: "C", type: "BS4K", channel: "C46", route: "CATV", tsmfRelTs });
      assert.strictEqual(channel.tsmfRelTs, undefined);
      assert.strictEqual(channel.toJSON().tsmfRelTs, tsmfRelTs);
    }
  });

  it("receives the relative stream of the network of the service not received yet", () => {
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
    _.channel = {
      getStreams: () => [
        { networkId: 4, streamId: 18801, relTs: 2, slots: 40, format: "ts" },
        { networkId: 11, streamId: 45168, relTs: 5, slots: 12, format: "tlv" }
      ],
      findStreamLocations: () => []
    };
    const tlv = new ServiceItem(channel, 11, 151, "4K", 1, -1, undefined, false, 0, undefined);
    assert.deepStrictEqual([tlv.targets[0].relTs, tlv.format], [5, "tlv"]);
    // the relative stream of the most slots if no relative streams of the network
    const other = new ServiceItem(channel, 7, 1, "x", 1, -1, undefined, false, 0, undefined);
    assert.deepStrictEqual([other.targets[0].relTs, other.format], [2, "ts"]);
  });

  it("uses the relative stream of the most slots without specifying, the smaller number if the same", () => {
    const streamsOf = list => ({ getStreams: () => list });
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C45", route: "CATV" });

    _.channel = streamsOf([{ networkId: 4, streamId: 20227, relTs: 9, slots: 8 }, { networkId: 4, streamId: 20225, relTs: 1, slots: 44 }]);
    assert.strictEqual(channel.defaultRelTs, 1);
    _.channel = streamsOf([{ networkId: 4, streamId: 18803, relTs: 3, slots: 24 }, { networkId: 4, streamId: 18801, relTs: 2, slots: 24 }]);
    assert.strictEqual(channel.defaultRelTs, 2);
    // channels.yml の tsmfRelTs が優先
    assert.strictEqual(new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV", tsmfRelTs: 3 }).defaultRelTs, 3);
    _.channel = streamsOf([{ networkId: 4, streamId: 20225 }]);
    assert.strictEqual(channel.defaultRelTs, undefined);
  });

  it("tunes the relative stream and the format of the stream of the service", () => {
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
    const streams = [
      { networkId: 4, streamId: 18801, relTs: 2, slots: 24, format: "ts" },
      { networkId: 11, streamId: 45168, relTs: 5, slots: 28, format: "tlv" }
    ];
    _.channel = {
      getStreams: () => streams,
      findStreamLocations: (networkId, streamId) => streams.filter(s => s.networkId === networkId && s.streamId === streamId).map(stream => ({ channel, stream }))
    };
    const t = Object.create(Tuner.prototype);
    t._devices = [{ index: 0, config: { name: "t", types: ["BS"], routes: ["CATV"] } }];

    const ts = new ServiceItem(channel, 4, 265, "BS", 1, -1, undefined, false, 0, 18801);
    const tlv = new ServiceItem(channel, 11, 151, "4K", 1, -1, undefined, false, 0, 45168);
    assert.deepStrictEqual(t._getCandidates(ts.targets).map(({ relTs, format }) => ({ relTs, format })), [{ relTs: 2, format: "ts" }]);
    assert.deepStrictEqual(t._getCandidates(tlv.targets).map(({ relTs, format }) => ({ relTs, format })), [{ relTs: 5, format: "tlv" }]);
    assert.strictEqual(tlv.isTlv, true);
    assert.strictEqual(ts.isTlv, false);
  });

  it("uses the relative stream to receive for the format of the service not received yet", () => {
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
    _.channel = {
      getStreams: () => [
        { networkId: 4, streamId: 18801, relTs: 2, slots: 24, format: "ts" },
        { networkId: 11, streamId: 45168, relTs: 5, slots: 28, format: "tlv" }
      ],
      findStreamLocations: () => []
    };
    // the service saved without streamId (before 4.3.0) is received from the relative stream of the most slots
    const service = new ServiceItem(channel, 11, 151, "4K", 1, -1, undefined, false, 0, undefined);
    assert.deepStrictEqual(service.targets.map(({ relTs }) => relTs), [5]);
    assert.strictEqual(service.format, "tlv");
  });

  it("uses the configured format for the relative stream of tsmfRelTs over the detected format", async () => {
    for (const [configured, detected] of [["ts", "tlv"], ["tlv", "ts"]]) {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV", format: configured, tsmfRelTs: 5 });
      const stream = { networkId: 11, streamId: 45168, relTs: 5, slots: 28, format: detected };
      _.channel = {
        getStreams: () => [stream],
        findStreamLocations: () => [{ channel, stream }]
      };
      const service = new ServiceItem(channel, 11, 151, "4K", 1, -1, undefined, false, 0, 45168);
      _.service = { get: () => service };
      const tuner = Object.create(Tuner.prototype);
      tuner._devices = [{ config: { types: ["BS"], routes: ["CATV"] } }];
      const picked = [];
      tuner._initTS = async (user, output, candidates) => picked.push(...candidates);
      await tuner.initServiceStream(service, { id: "service" });
      await tuner.initProgramStream({ networkId: 11, serviceId: 151, eventId: 1 }, { id: "program" });
      assert.strictEqual(service.format, configured);
      assert.deepStrictEqual(picked.map(({ relTs, format }) => ({ relTs, format })), [
        { relTs: 5, format: configured }, { relTs: 5, format: configured }
      ]);
    }
  });

  it("uses the formats detected for the relative streams detected, and TS for the stream as received", () => {
    const streams = [
      { networkId: 4, streamId: 18801, relTs: 2, slots: 24, format: "ts" },
      { networkId: 11, streamId: 45168, relTs: 5, slots: 28, format: "tlv" }
    ];
    _.channel = { getStreams: () => streams };
    // `format` of channels.yml is for the stream of the channel (the stream as received without tsmfRelTs)
    const configured = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV", format: "ts" });
    assert.deepStrictEqual([configured.getFormat(2), configured.getFormat(5), configured.format], ["ts", "tlv", "ts"]);
    // TSMF is TS outside, even for the type of TLV by default
    const bs4k = new ChannelItem({ name: "C", type: "BS4K", channel: "C46", route: "CATV" });
    assert.deepStrictEqual([bs4k.getFormat(2), bs4k.getFormat(5), bs4k.format], ["ts", "tlv", "ts"]);
    _.channel = { getStreams: () => [] };
    assert.strictEqual(bs4k.format, "tlv");
  });

  it("gathers TS and TLV EPG from their own relative streams when they share a channel", async () => {
    const Channel = require("../lib/Mirakurun/Channel").default;
    for (const [tsSlots, tlvSlots] of [[40, 12], [12, 40]]) {
      const jobs = [];
      const calls = [];
      _.job = { add: job => jobs.push(job), addSchedule: () => {} };
      _.config = { server: {}, channels: [{ name: "C", type: "BS", channel: "C46", route: "CATV" }] };
      _.tuner = {
        typeExists: () => true,
        readyForJob: async targets => targets[0].channel,
        getEPG: async (channel, user, relTs) => calls.push(relTs)
      };
      const channels = new Channel();
      _.channel = channels;
      const channel = channels.items[0];
      // Load the detected streams without scheduling a DB write in this test.
      channels._streams.set(channel, [
        { networkId: 11, streamId: 1, relTs: 1, slots: tsSlots, format: "ts" },
        { networkId: 11, streamId: 2, relTs: 2, slots: tlvSlots, format: "tlv" }
      ]);
      _.service = { items: [
        new ServiceItem(channel, 11, 101, "TS", 1, -1, undefined, false, 0, 1),
        new ServiceItem(channel, 11, 102, "TLV", 1, -1, undefined, false, 0, 2)
      ] };
      const gatherer = jobs.find(job => job.key === "EPG.Gatherer");
      jobs.length = 0;
      await gatherer.fn();
      assert.deepStrictEqual(jobs.map(job => job.key), ["EPG.Gather.NID.11", "EPG.Gather.NID.11.TSID.2"]);
      for (const job of jobs) {
        assert.strictEqual(await job.readyFn(), true);
        await job.fn();
      }
      assert.deepStrictEqual(calls, [1, 2]);
    }
  });

  it("detects the relative streams by the format detection of the service scan, only without tsmfRelTs", async () => {
    _.channel = { getStreams: () => [] };
    // 判別は 64KB を読み飛ばした後の 64KB で行う
    const data = Buffer.concat(Array.from({ length: 1400 }, (_, i) => header([[2, 24, false, 18801, 4], [5, 28, true, 45168, 11]], i)));
    const detected = [
      { relTs: 2, slots: 24, format: "ts", streamId: 18801, networkId: 4 },
      { relTs: 5, slots: 28, format: "tlv", streamId: 45168, networkId: 11 }
    ];
    for (const [tsmfRelTs, expected] of [[undefined, { format: "ts", tsmf: detected }], [5, { format: "tlv", tsmf: null }]]) {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV", tsmfRelTs });
      const streamSetting = { channel };
      const device = {
        config: { name: "t", types: ["BS"], tlvToTsDecoder: "mmt2ts" }, isRemote: false, users: [{ id: "scan", streamSetting }],
        async startStream(user, sink) {
          setImmediate(() => sink.write(data));
        }
      };
      const t = Object.create(Tuner.prototype);
      t._devices = [device];
      const probe = t._startFormatProbe({ id: "scan", priority: -1, streamSetting });
      assert.strictEqual(probe.tsmf, tsmfRelTs === undefined);
      assert.deepStrictEqual(await probe.detected, expected);
    }
  });

  it("requires consecutive headers and discovers multiple carriers without using a previous channel header", async () => {
    _.channel = { getStreams: () => [] };
    const streams = [[2, 24, false, 18801, 4], [5, 28, true, 45168, 11]];
    const nullPackets = n => Buffer.concat(Array.from({ length: n }, () => Buffer.from([0x47, 0x1F, 0xFF, 0x10, ...new Array(184).fill(0xFF)])));
    const multiCarrier = p => {
      const payload = p.subarray(4);
      payload[2] = (payload[2] & 0xF0) | 0x02;
      payload[124] = 2;
      payload[125] = 1;
      payload.writeUInt32BE(crc32(payload.subarray(0, 180)), 180);
      return p;
    };
    // 判別は 64KB を読み飛ばした後の 64KB で行う (continuity_counter が毎回飛ぶ: パケットの欠落)
    for (const [data, expected] of [
      [Buffer.concat(Array.from({ length: 1400 }, (_, i) => header(streams, i * 2))), null],
      [Buffer.concat(Array.from({ length: 1400 }, (_, i) => multiCarrier(header(streams, i)))), { format: "ts", tsmf: [
        { relTs: 2, slots: 24, format: "ts", streamId: 18801, networkId: 4, groupId: 255, numberOfCarriers: 2, carrierSequence: 1 },
        { relTs: 5, slots: 28, format: "tlv", streamId: 45168, networkId: 11, groupId: 255, numberOfCarriers: 2, carrierSequence: 1 }
      ] }],
      // a header of multiple carriers of the channel tuned before remains
      // (the first 64KB are skipped, the header is right after them)
      [Buffer.concat([nullPackets(349), multiCarrier(header(streams, 0)), ...Array.from({ length: 1400 }, (_, i) => header(streams, 3 + i))]), { format: "ts", tsmf: [
        { relTs: 2, slots: 24, format: "ts", streamId: 18801, networkId: 4 },
        { relTs: 5, slots: 28, format: "tlv", streamId: 45168, networkId: 11 }
      ] }]
    ]) {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
      const streamSetting = { channel };
      const device = {
        config: { name: "t", types: ["BS"], tlvToTsDecoder: "mmt2ts" }, isRemote: false, users: [{ id: "scan", streamSetting }],
        async startStream(user, sink) {
          setImmediate(() => sink.write(data));
        }
      };
      const t = Object.create(Tuner.prototype);
      t._devices = [device];
      assert.deepStrictEqual(await t._startFormatProbe({ id: "scan", priority: -1, streamSetting }).detected, expected);
    }
  });

  it("uses the stream as received for the format of the channel, not the relative stream of the most slots", () => {
    _.channel = { getStreams: () => [{ networkId: 4, streamId: 18801, relTs: 2, slots: 12, format: "ts" }, { networkId: 11, streamId: 45168, relTs: 5, slots: 40, format: "tlv" }] };
    assert.strictEqual(new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" }).format, "ts");
    assert.strictEqual(new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV", tsmfRelTs: 5 }).format, "tlv");
  });

  it("outputs the channel stream as received without tsmfRelTs, as before (for the remote Mirakurun)", async () => {
    const express = require("express");
    const openapi = require("express-openapi");
    const http = require("http");
    const op = require("../lib/Mirakurun/api/channels/{type}/{channel}/stream");
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
    const streams = [{ networkId: 4, streamId: 18801, relTs: 2, slots: 12, format: "ts" }, { networkId: 4, streamId: 18803, relTs: 3, slots: 40, format: "ts" }];
    _.channel = { get: () => channel, getStreams: () => streams };
    _.config = { server: {} };
    const t = Object.create(Tuner.prototype);
    t._devices = [{ config: { name: "t", types: ["BS"] }, isRemote: false }];
    const requested = [];
    t.initChannelStream = async (ch, userReq, output, relTs) => {
      requested.push(relTs);
      setImmediate(() => output.end());
      const filter = new EventEmitter();
      filter.close = () => {};
      return filter;
    };
    _.tuner = t;
    const app = express();
    openapi.initialize({
      app,
      apiDoc: { swagger: "2.0", info: { title: "t", version: "1" }, basePath: "/api", paths: {} },
      paths: [{ path: "/channels/{type}/{channel}/stream", module: op }]
    });
    const server = await new Promise(resolve => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const status = path => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: server.address().port, path: `/api/channels/BS/C46/stream${path}` }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }).on("error", reject);
    });
    try {
      assert.strictEqual(await status(""), 200);
      assert.strictEqual(await status("?tsmfRelTs=2"), 200);
      assert.strictEqual(await status("?tsmfRelTs=9"), 404);
      assert.deepStrictEqual(requested, [undefined, 2]);
    } finally {
      server.close();
    }
  });

  it("is ready for the job of the relative stream detected only by the local tuners", async () => {
    const remote = { index: 0, config: { name: "remote", types: ["BS"] }, isRemote: true, isAvailable: true, isFree: true, users: [], getPriority: () => -2 };
    const local = { index: 1, config: { name: "local", types: ["BS"] }, isRemote: false, isAvailable: true, isFree: true, users: [], getPriority: () => -2 };
    const t = Object.create(Tuner.prototype);
    t._devices = [remote, local];
    t._readyForJobPickedDeviceSet = new Set();
    _.channel = { getStreams: () => [] };
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46" });
    // the remote tuner is not picked (the former) for the relative stream detected
    assert.strictEqual(await t.readyForJob([{ channel, relTs: 5 }]), channel);
    assert.deepStrictEqual([...t._readyForJobPickedDeviceSet], [local]);
    t._readyForJobPickedDeviceSet.clear();
    assert.strictEqual(await t.readyForJob([{ channel }]), channel);
    assert.deepStrictEqual([...t._readyForJobPickedDeviceSet], [remote]);
    t._readyForJobPickedDeviceSet.clear();
  });

  it("shows tsmfRelTs of the stream setting only for the relative stream detected (as before for tsmfRelTs of channels.yml)", async () => {
    _.channel = { getStreams: () => [] };
    _.config = { server: {} };
    const device = {
      index: 0, config: { name: "t", types: ["BS"] }, isRemote: false, isAvailable: true, isFree: true, users: [], channel: null,
      decoder: null, getPriority: () => -2,
      async startStream() {}
    };
    const t = Object.create(Tuner.prototype);
    t._devices = [device];
    for (const [config, relTs, expected] of [[{ tsmfRelTs: 3 }, 3, undefined], [{}, 5, 5]]) {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", ...config });
      const user = { id: "u", priority: 0, disableDecoder: true, streamSetting: { channel } };
      const filter = await t._initTS(user, undefined, [t._getCandidate(channel, relTs, "ts")]);
      assert.strictEqual(user.streamSetting.tsmfRelTs, expected);
      filter.close();
    }
  });

  it("parses EIT of the network of TS for the stream as received, and does not receive the relative stream specified by the remote tuners", async () => {
    const streams = [
      { networkId: 11, streamId: 45168, relTs: 1, slots: 28, format: "tlv" },
      { networkId: 4, streamId: 18801, relTs: 2, slots: 24, format: "ts" }
    ];
    _.channel = { getStreams: () => streams };
    // the services of TLV come first
    _.service = { findByChannel: () => [{ networkId: 11, serviceId: 151 }, { networkId: 4, serviceId: 101 }] };
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
    const t = Object.create(Tuner.prototype);
    const users = [];
    t._initTS = async (user, output, candidates) => users.push([user.streamSetting.networkId, candidates[0].relTs]);
    t._devices = [{ config: { name: "local", types: ["BS"] }, isRemote: false }];
    await t.initChannelStream(channel, { id: "u" }, null);
    await t.initChannelStream(channel, { id: "u" }, null, 1);
    assert.deepStrictEqual(users, [[4, undefined], [11, 1]]);
    t._devices = [{ config: { name: "remote", types: ["BS"] }, isRemote: true }];
    await assert.rejects(t.initChannelStream(channel, { id: "u" }, null, 1), /no available tuners/);
  });

  it("receives the stream of the channel as before if only the remote tuners are left", async () => {
    const remote = { index: 0, config: { name: "remote", types: ["BS"] }, isRemote: true, isAvailable: true, isFree: true, users: [], getPriority: () => -2 };
    const t = Object.create(Tuner.prototype);
    t._devices = [remote];
    t._readyForJobPickedDeviceSet = new Set();
    _.channel = { getStreams: () => [{ networkId: 11, streamId: 45168, relTs: 5, slots: 28, format: "tlv" }] };
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46" });
    const candidate = t._getCandidate(channel, 5);
    assert.deepStrictEqual([candidate.relTs, candidate.format, candidate.devices], [undefined, "ts", [remote]]);
    assert.strictEqual(t.getOutputFormat([{ channel, relTs: 5 }]), "ts");
    assert.strictEqual(await t.readyForJob([{ channel, relTs: 5 }]), channel);
    t._readyForJobPickedDeviceSet.clear();
  });

  it("decides the output format by the relative stream of each candidate", () => {
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
    _.channel = {
      getStreams: () => [
        { networkId: 4, streamId: 18801, relTs: 2, slots: 24, format: "ts" },
        { networkId: 11, streamId: 45168, relTs: 5, slots: 28, format: "tlv" }
      ]
    };
    const t = Object.create(Tuner.prototype);
    t._devices = [{ config: { name: "t", types: ["BS"], routes: ["CATV"] } }];
    assert.strictEqual(t.getOutputFormat([{ channel, relTs: 2 }]), "ts");
    assert.strictEqual(t.getOutputFormat([{ channel, relTs: 5 }]), "tlv");
    assert.strictEqual(t.getOutputFormat([{ channel, relTs: 5 }], "ts"), null);
    // TS が先頭の候補でも、TLV の候補があれば TLV を出力できる
    assert.strictEqual(t.getOutputFormat([{ channel, relTs: 2 }, { channel, relTs: 5 }], "tlv"), "tlv");
  });

  it("receives the relative streams detected only by the local tuners", () => {
    const local = { config: { name: "local", types: ["BS"] }, isRemote: false };
    const remote = { config: { name: "remote", types: ["BS"] }, isRemote: true };
    const t = Object.create(Tuner.prototype);
    t._devices = [local, remote];
    _.channel = { getStreams: () => [] };
    const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46" });
    const configured = new ChannelItem({ name: "C", type: "BS", channel: "C47", tsmfRelTs: 5 });
    // the remote Mirakurun outputs the relative stream of its own
    assert.deepStrictEqual(t._getCandidate(channel, 5).devices, [local]);
    assert.deepStrictEqual(t._getCandidate(channel).devices, [local, remote]);
    assert.deepStrictEqual(t._getCandidate(configured, 5).devices, [local, remote]);
  });

  it("scans again in the format detected with the tuner (not the user of the first scan)", async () => {
    const channel = new ChannelItem({ name: "GR", type: "GR", channel: "27" });
    _.channel = { get: () => channel, getStreams: () => [], setStreams: () => {} };
    const filters = [];
    const device = {
      index: 0, config: { name: "t", types: ["GR"], tlvToTsDecoder: "mmt2ts" }, isRemote: false, isAvailable: true, isFree: true, users: [], channel: null,
      decoder: null, getPriority: () => -2,
      async startStream(user, filter) {
        this.channel = channel;
        filters.push(filter);
      }
    };
    const t = Object.create(Tuner.prototype);
    t._devices = [device];
    t._startFormatProbe = () => ({ detected: Promise.resolve({ format: "tlv", tsmf: null }), tsmf: true, end: () => {} });
    const scanned = t.getServices(channel);
    while (filters.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    filters[1].close();
    await assert.rejects(scanned, /stream has closed before get network/);
    assert.strictEqual(filters[1].constructor.name, "TLVFilter");
  });

  describe("service scan", () => {
    const detected = [
      { relTs: 2, slots: 24, format: "ts", streamId: 18801, networkId: 4 },
      { relTs: 5, slots: 20, format: "tlv", streamId: 45168, networkId: 11 },
      // サービスのない相対 TS (技術試験など)
      { relTs: 9, slots: 8, format: "ts", streamId: 18809, networkId: 4 }
    ];

    function scanner(tsmf, detectDelay) {
      const t = Object.create(Tuner.prototype);
      // the local tuner detected
      t._devices = [{ config: { name: "4k", types: ["BS"], tlvToTsDecoder: "mmt2ts" }, isRemote: false }];
      t.scans = [];
      t._initTS = async (user, dest, candidates) => {
        const { relTs, format, devices } = candidates[0];
        const scan = { relTs, format, devices, startedAt: Date.now() };
        t.scans.push(scan);
        const filter = new EventEmitter();
        filter.closed = false;
        filter.close = () => {
          if (!filter.closed) {
            filter.closed = true;
            scan.closedAt = Date.now();
            filter.emit("close");
          }
        };
        setTimeout(() => {
          if (relTs === 9) {
            filter.close();
            return;
          }
          filter.emit("network", { networkId: 4, areaCode: -1, remoteControlKeyId: -1 });
          filter.emit("services", [{ networkId: 4, serviceId: 100 + (relTs || 0), streamId: relTs || 0 }]);
        }, relTs === undefined ? 0 : 50);
        return filter;
      };
      t._startFormatProbe = () => ({
        detected: new Promise(resolve => setTimeout(() => resolve({ format: "ts", tsmf }), detectDelay)),
        tsmf: true,
        end: () => {}
      });
      return t;
    }

    // チャンネルスキャン (登録していないチャンネル) は、相対 TS ごとのサービスを返し、channels.json には保存しない
    it("returns the services of each relative stream for the channel scan, detecting on any local tuner", async () => {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
      const saved = [];
      _.channel = { get: () => null, getStreams: () => [], setStreams: (item, streams) => saved.push(streams) };
      const t = scanner(detected, 0);
      const probe = t._startFormatProbe;
      const anyTuner = [];
      t._startFormatProbe = (user, any) => (anyTuner.push(any), probe(user, any));

      const streams = await t.scanChannel(channel);
      assert.deepStrictEqual(anyTuner, [true]);
      assert.deepStrictEqual(streams.map(({ relTs, format, services }) => [relTs, format, services.map(s => s.serviceId)]), [
        [2, "ts", [102]],
        [5, "tlv", [105]],
        [9, "ts", []]
      ]);
      // the network of the TSMF header, and the relative stream failed to scan
      assert.deepStrictEqual(streams.map(({ networkId, failed }) => [networkId, failed]), [[4, undefined], [11, undefined], [4, true]]);
      assert.deepStrictEqual(saved, []);

      // without TSMF
      const plain = scanner(null, 0);
      assert.deepStrictEqual((await plain.scanChannel(channel)).map(({ relTs, format, services }) => [relTs, format, services.map(s => s.serviceId)]), [
        [undefined, "ts", [100]]
      ]);

      // the tuners to try (the channel scan tries the tuners of the route one by one)
      const another = { config: { name: "4k-2", types: ["BS"] }, isRemote: false };
      plain._devices.push(another);
      await plain.scanChannel(channel, {}, [another]);
      assert.deepStrictEqual(plain.scans.at(-1).devices, [another]);
    });

    // 複数の搬送波の TLV は、ほかの搬送波が見つかるまでスキャンしないため、TS のスキャンに失敗しても搬送波を返す
    it("returns the carrier bonded for the channel scan, even if the scan of TS fails", async () => {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
      _.channel = { get: () => null, getStreams: () => [], setStreams: () => {} };
      // the header of multiple carriers is copied to all the relative streams
      const carrier = { groupId: 1, numberOfCarriers: 2, carrierSequence: 0 };
      const ts = { relTs: 9, slots: 8, format: "ts", streamId: 18809, networkId: 4, ...carrier };
      const t = scanner([ts, { relTs: 5, slots: 20, format: "tlv", streamId: 45168, networkId: 11, ...carrier }], 0);
      const streams = await t.scanChannel(channel);
      assert.deepStrictEqual(streams.map(({ relTs, format, services, numberOfCarriers }) => [relTs, format, services.length, numberOfCarriers]), [
        [9, "ts", 0, 2],
        [5, "tlv", 0, 2]
      ]);
      assert.deepStrictEqual(t.scans.map(({ relTs }) => relTs), [undefined, 9]);

      // without the TLV of multiple carriers, the error of the scan (the other tuners are tried)
      for (const detected of [[{ relTs: 9, slots: 8, format: "ts", streamId: 18809, networkId: 4 }], [ts]]) {
        _.channel = { get: () => null, getStreams: () => [], setStreams: () => {} };
        await assert.rejects(scanner(detected, 0).scanChannel(channel), /stream has closed/);
      }
    });

    it("detects the format on the local tuners only for TS by the channel scan only", async () => {
      _.channel = { getStreams: () => [] };
      const data = Buffer.concat(Array.from({ length: 1400 }, (_, i) => header([[2, 24, false, 18801, 4]], i)));
      for (const isRemote of [false, true]) {
        const channel = new ChannelItem({ name: "C", type: "GR", channel: "C46", route: "CATV" });
        const streamSetting = { channel };
        const device = {
          config: { name: "t", types: ["GR"] }, isRemote, users: [{ id: "scan", streamSetting }],
          async startStream(user, sink) {
            setImmediate(() => sink.write(data));
          }
        };
        const t = Object.create(Tuner.prototype);
        t._devices = [device];
        const user = { id: "scan", priority: -1, streamSetting };
        assert.strictEqual(t._startFormatProbe(user), null);
        const probe = t._startFormatProbe(user, true);
        if (isRemote) {
          assert.strictEqual(probe, null);
        } else {
          assert.deepStrictEqual(await probe.detected, { format: "ts", tsmf: [{ relTs: 2, slots: 24, format: "ts", streamId: 18801, networkId: 4 }] });
        }
      }
    });

    it("scans all the relative streams at the same time, and saves the streams of them", async () => {
      // 判別の前に、相対 TS の混ざったスキャンが終わる場合も相対 TS ごとにスキャンする
      for (const detectDelay of [0, 100]) {
        const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
        const saved = [];
        _.channel = { get: () => channel, getStreams: () => [], setStreams: (item, streams) => saved.push(streams) };
        const t = scanner(detected, detectDelay);
        const services = await t.getServices(channel);
        assert.deepStrictEqual(services.map(s => s.serviceId), [102, 105]);
        assert.deepStrictEqual(t.scans.map(({ relTs, format }) => [relTs, format]), [[undefined, "ts"], [2, "ts"], [5, "tlv"], [9, "ts"]]);
        const relTsScans = t.scans.slice(1);
        assert.ok(Math.max(...relTsScans.map(s => s.startedAt)) <= Math.min(...relTsScans.map(s => s.closedAt)));
        // the stream of the services scanned is saved, the one of the TSMF header only without services
        assert.deepStrictEqual(saved, [[
          { ...detected[0], networkId: 4, streamId: 2 },
          { ...detected[1], networkId: 4, streamId: 5 },
          detected[2]
        ]]);
      }
    });

    it("keeps the relative streams detected when the scan does not detect, and replaces them when the detection finds no TSMF", async () => {
      const detecting = { config: { name: "4k", types: ["BS"], tlvToTsDecoder: "mmt2ts" }, isRemote: false };
      const remote = { config: { name: "remote", types: ["BS"] }, isRemote: true };
      for (const [probe, devices, replaced] of [
        [null, [remote, detecting], false],
        [{ detected: Promise.resolve({ format: "ts", tsmf: null }), tsmf: true, end: () => {} }, [detecting], true],
        // no tuners detect any longer (the relative streams detected cannot be received by the remote tuners)
        [null, [remote], true]
      ]) {
        const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
        let streams = detected.map(({ networkId, streamId, format, relTs, slots }) => ({ networkId, streamId, format, relTs, slots }));
        _.channel = { get: () => channel, getStreams: () => streams, setStreams: (item, list) => streams = list };
        const t = scanner(null, 0);
        t._devices = devices;
        // the tuners only for TS (or the remote tuners) do not detect
        t._startFormatProbe = () => probe;
        const services = await t.getServices(channel);
        assert.deepStrictEqual(services.map(s => s.serviceId), [100]);
        assert.strictEqual(streams.length === 1, replaced, JSON.stringify(streams));
      }
    });

    it("keeps the stream received before for the relative stream whose scan has failed", async () => {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
      // relTs 9 was received as TS before, its scan fails this time
      let streams = [{ networkId: 4, streamId: 9, format: "ts", relTs: 9, slots: 8 }];
      _.channel = { get: () => channel, getStreams: () => streams, setStreams: (item, list) => streams = list };
      const tlv9 = detected.map(stream => stream.relTs === 9 ? { ...stream, format: "tlv" } : stream);
      await scanner(tlv9, 0).getServices(channel);
      assert.deepStrictEqual(streams.find(stream => stream.relTs === 9), { networkId: 4, streamId: 9, format: "ts", relTs: 9, slots: 8 });
    });

    it("fails when no relative streams have services", async () => {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV" });
      const saved = [];
      _.channel = { get: () => channel, getStreams: () => [], setStreams: (item, streams) => saved.push(streams) };
      await assert.rejects(scanner([detected[2]], 0).getServices(channel), /before get network/);
      assert.deepStrictEqual(saved, []);
    });
  });
});
