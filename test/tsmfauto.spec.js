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
    assert.strictEqual(detectTSMFStreams(header(streams, 0)), null);
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

  it("uses the configured format for service and program streams over the detected format", async () => {
    for (const [configured, detected] of [["ts", "tlv"], ["tlv", "ts"]]) {
      const channel = new ChannelItem({ name: "C", type: "BS", channel: "C46", route: "CATV", format: configured });
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

  it("gathers TS and TLV EPG from their own relative streams when they share a channel", async () => {
    const Channel = require("../lib/Mirakurun/Channel").default;
    for (const [tsSlots, tlvSlots] of [[40, 12], [12, 40]]) {
      const jobs = [];
      const calls = [];
      _.job = { add: job => jobs.push(job), addSchedule: () => {} };
      _.config = { server: {}, channels: [{ name: "C", type: "BS", channel: "C46", route: "CATV" }] };
      _.tuner = {
        typeExists: () => true,
        readyForJob: async channels => channels[0],
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
      t._devices = [];
      t.scans = [];
      t._initTS = async (user, dest, candidates) => {
        const { relTs, format } = candidates[0];
        const scan = { relTs, format, startedAt: Date.now() };
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
        assert.deepStrictEqual(saved, [detected]);
      }
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
