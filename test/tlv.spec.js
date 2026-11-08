const { describe, it, before, beforeEach, after, mock } = require("node:test");
const assert = require("assert");
const http = require("http");
const path = require("path");
const { Writable, PassThrough } = require("stream");
const child_process = require("child_process");
const { EventEmitter } = require("events");
const express = require("express");

// status.ts のタイマーでテストのプロセスが終了しなくなるため差し替える
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
const status = { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0, decoderRespawn: 0 } };
require.cache[statusPath] = {
  id: statusPath,
  filename: statusPath,
  loaded: true,
  exports: { __esModule: true, default: status }
};

const _ = require("../lib/Mirakurun/_").default;
const log = require("../lib/Mirakurun/log");
let MHEPG;
let TLVFilter;
let TSDecoder;
let Tuner;
let ChannelItem;

const tick = () => new Promise(resolve => setImmediate(resolve));

// MJD+BCD (JST)
function mjdBCD(mjd, hh, mm, ss) {
  const bcd = n => ((n / 10) | 0) << 4 | n % 10;
  return mjd * (1 << 24) + (bcd(hh) << 16) + (bcd(mm) << 8) + bcd(ss);
}

function eit(events, overrides = {}) {
  return {
    tableId: "EIT[schedule basic]",
    tableIdNumber: 0x8C,
    tableIndex: 0,
    serviceId: 101,
    versionNumber: 1,
    currentNextIndicator: true,
    sectionNumber: 0,
    lastSectionNumber: 0,
    tlvStreamId: 0x0800,
    originalNetworkId: 11,
    segmentLastSectionNumber: 0,
    lastTableId: 0x8C,
    lastTableIndex: 0,
    events,
    ...overrides
  };
}

function tlvPacket(n, length) {
  const p = Buffer.alloc(4 + length, n);
  p[0] = 0x7F;
  p[1] = 0xFE; // null packet
  p.writeUInt16BE(length, 2);
  return p;
}

function tuner(devices) {
  const t = Object.create(Tuner.prototype);
  t._devices = devices;
  t._readyForJobPickedDeviceSet = new Set();
  return t;
}

function fakeDevice(index, config) {
  return { index, config: { name: `tuner${index}`, ...config }, isAvailable: true, isFree: true, users: [], getPriority: () => -2 };
}

describe("[tlv.spec] TLV (MMT)", () => {
  before(() => {
    for (const level of ["info", "debug", "warn", "error", "fatal"]) {
      log[level] = () => {};
    }
    _.config = { server: {} };
    MHEPG = require("../lib/Mirakurun/MHEPG").default;
    TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
    TSDecoder = require("../lib/Mirakurun/TSDecoder").default;
    Tuner = require("../lib/Mirakurun/Tuner").default;
    ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
  });

  describe("MHEPG", () => {
    let programs;
    beforeEach(() => {
      programs = new Map();
      _.program = {
        exists: id => programs.has(id),
        add: item => programs.set(item.id, { ...item }),
        set: (id, props) => Object.assign(programs.get(id), props)
      };
    });

    it("keeps MH-EIT video metadata separate from the legacy TS video contract", () => {
      const epg = new MHEPG();
      epg.write(eit([{
        eventId: 1,
        startTime: mjdBCD(61000, 12, 30, 0),
        duration: 0x013000,
        freeCAMode: false,
        descriptors: [
          { tag: "mhShortEvent", eventName: Buffer.from("番組"), text: Buffer.from("説明") },
          { tag: "videoComponent", videoResolution: 6, videoScanFlag: 1, videoFrameRate: 8, videoTransferCharacteristics: 5, componentTag: 0 }
        ]
      }]));

      const [program] = programs.values();
      assert.strictEqual(program.name, "番組");
      assert.strictEqual(program.description, "説明");
      assert.strictEqual(program.duration, 90 * 60 * 1000);
      assert.strictEqual(program.isFree, true);
      assert.strictEqual(program.video, undefined);
      assert.deepStrictEqual(program.mmtVideo, {
        resolution: "2160p",
        frameRate: "59.94",
        transferCharacteristics: "bt2100-hlg"
      });
    });

    it("concatenates the extended event items continued from the previous one", () => {
      const epg = new MHEPG();
      const item = (description, text) => ({ itemDescription: Buffer.from(description), item: Buffer.from(text) });
      // UTF-8 の文字が項目の境目で分かれている
      const text = Buffer.from("出演者は山田");
      epg.write(eit([{
        eventId: 1,
        startTime: mjdBCD(61000, 12, 30, 0),
        duration: 0x003000,
        freeCAMode: false,
        descriptors: [
          { tag: "mhExtendedEvent", descriptorNumber: 0, lastDescriptorNumber: 1, items: [item("出演", text.subarray(0, 4))] },
          { tag: "mhExtendedEvent", descriptorNumber: 1, lastDescriptorNumber: 1, items: [item("", text.subarray(4)), item("番組内容", "内容")] }
        ]
      }]));

      const [program] = programs.values();
      assert.deepStrictEqual(program.extended, { 出演: "出演者は山田", 番組内容: "内容" });
    });

    it("marks the present and the following program by EIT[p/f]", () => {
      const epg = new MHEPG();
      const event = eventId => ({ eventId, startTime: mjdBCD(61000, 12, 30, 0), duration: 0x003000, freeCAMode: false, descriptors: [] });
      epg.write(eit([event(1)], { tableId: "EIT[p/f]", tableIdNumber: 0x8B, sectionNumber: 0 }));
      epg.write(eit([event(2)], { tableId: "EIT[p/f]", tableIdNumber: 0x8B, sectionNumber: 1 }));

      const [present, following] = programs.values();
      assert.strictEqual(present._isPresent, true);
      assert.strictEqual(following._isFollowing, true);
    });

    it("updates the program existing (stored) by the table received next", () => {
      const { getProgramItemId } = require("../lib/Mirakurun/Program");
      const id = getProgramItemId(11, 101, 2);
      programs.set(id, { id, startAt: Date.UTC(2025, 10, 21, 3, 0, 0), duration: 30 * 60 * 1000 });
      const epg = new MHEPG();
      const table = eit([{ eventId: 2, startTime: mjdBCD(61000, 13, 0, 0), duration: 0x003000, freeCAMode: false, descriptors: [] }], { versionNumber: 2 });
      epg.write(table);
      epg.write(table);

      assert.strictEqual(programs.get(id).startAt, Date.UTC(2025, 10, 21, 4, 0, 0));
    });

    it("does not overwrite the program existing (stored) by the schedule after EIT[p/f]", () => {
      const { getProgramItemId } = require("../lib/Mirakurun/Program");
      const id = getProgramItemId(11, 101, 2);
      programs.set(id, { id, startAt: Date.UTC(2025, 10, 21, 3, 0, 0), duration: 30 * 60 * 1000 });
      const epg = new MHEPG();
      const event = startTime => ({ eventId: 2, startTime, duration: 0x003000, freeCAMode: false, descriptors: [] });
      epg.write(eit([event(mjdBCD(61000, 13, 0, 0))], { tableId: "EIT[p/f]", tableIdNumber: 0x8B, sectionNumber: 1 }));
      epg.write(eit([event(mjdBCD(61000, 13, 5, 0))]));

      assert.strictEqual(programs.get(id).startAt, Date.UTC(2025, 10, 21, 4, 0, 0));
      assert.strictEqual(programs.get(id)._isFollowing, true);
    });

    it("does not overwrite the program by EIT[p/f] with the schedule", () => {
      const epg = new MHEPG();
      const event = startTime => ({ eventId: 2, startTime, duration: 0x003000, freeCAMode: false, descriptors: [] });
      epg.write(eit([event(mjdBCD(61000, 13, 0, 0))], { tableId: "EIT[p/f]", tableIdNumber: 0x8B, sectionNumber: 1 }));
      epg.write(eit([event(mjdBCD(61000, 13, 5, 0))]));

      const [following] = programs.values();
      assert.strictEqual(following._isFollowing, true);
      assert.strictEqual(following.startAt, Date.UTC(2025, 10, 21, 4, 0, 0));
    });
  });

  describe("TLVFilter", () => {
    it("holds the output while the output is full, dropping the oldest over the limit", async () => {
      _.config = { server: { maxBufferBytesBeforeReady: 1000 } };
      const written = [];
      let release;
      const output = new Writable({
        highWaterMark: 100,
        write(chunk, encoding, callback) {
          written.push(Buffer.from(chunk));
          // 最初の書き込みの後は、受信が止まったクライアントと同じく完了しない
          if (written.length === 1) {
            callback();
          } else {
            release = callback;
          }
        }
      });
      const filter = new TLVFilter({ output });
      const chunk = n => Buffer.concat([tlvPacket(n, 146), tlvPacket(n, 146)]);

      filter.write(chunk(1));
      filter.write(chunk(2));
      // ここから出力が詰まっている
      for (let n = 3; n <= 10; n++) {
        filter.write(chunk(n));
      }
      assert.deepStrictEqual(written.map(c => c[c.length - 1]), [1, 2]);
      assert.ok(status.errorCount.bufferOverflow > 0);

      release();
      await tick();
      filter.close();

      // 上限 (1000 バイト) を超えた古い分は破棄して、新しい分だけを書き出す
      const rest = Buffer.concat(written.slice(2));
      assert.strictEqual(rest.length, 1000);
      assert.strictEqual(rest[rest.length - 1], 10);
      _.config = { server: {} };
    });

    it("starts the output from the head of a TLV packet", () => {
      const written = [];
      const output = new Writable({ write: (chunk, encoding, callback) => { written.push(Buffer.from(chunk)); callback(); } });
      const filter = new TLVFilter({ output });
      const packets = Buffer.concat([tlvPacket(1, 10), tlvPacket(2, 10)]);
      filter.write(Buffer.concat([Buffer.from([0x00, 0x7F, 0x00]), packets]));
      filter.close();
      assert.ok(Buffer.concat(written).equals(packets));
    });

    it("ends the output when it is closed before any data", () => {
      const output = new PassThrough();
      const filter = new TLVFilter({ output });
      filter.close();
      assert.strictEqual(output.writableEnded, true);
    });

    it("is counted in the stream count of the status while it is open", () => {
      const count = status.streamCount.tsFilter;
      const filter = new TLVFilter({ output: new PassThrough() });
      assert.strictEqual(status.streamCount.tsFilter, count + 1);
      filter.close();
      filter.close();
      assert.strictEqual(status.streamCount.tsFilter, count);
    });
  });

  describe("TSDecoder (TLV decoders)", () => {
    it("runs the command with the arguments", async () => {
      const chunks = [];
      const output = new Writable({ write: (chunk, encoding, callback) => { chunks.push(chunk); callback(); } });
      const decoder = new TSDecoder({ output, command: `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`, withArgs: true, startupTimeout: 10000 });
      decoder.write(Buffer.from("tlv"));
      // the process may start slowly while the other tests run
      for (let i = 0; i < 1000 && chunks.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      decoder.end();
      assert.strictEqual(Buffer.concat(chunks).toString(), "tlv");
    });

    it("handles stdin failure and the ensuing child close only once", async () => {
      const output = new Writable({ write: (chunk, encoding, callback) => callback() });
      const decoder = new TSDecoder({ output, command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`, withArgs: true, passThroughOnFailure: false });
      const proc = decoder._process;
      const exited = new Promise(resolve => proc.once("close", resolve));
      try {
        proc.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
        await exited;
        assert.strictEqual(decoder._deadCount, 1);
        assert.strictEqual(output.writableEnded, false);
      } finally {
        decoder.end();
      }
    });

    // 4.3.0 と同じく、出力しないまま強制終了したプロセスは 2 回分の失敗として数える (2 回目のタイムアウトでパススルー)
    it("passes through the input after the process does not respond twice", { timeout: 20000 }, async () => {
      const chunks = [];
      const output = new Writable({ write: (chunk, encoding, callback) => { chunks.push(chunk); callback(); } });
      let spawned = 0;
      const spawn = child_process.spawn;
      mock.method(child_process, "spawn", (...args) => (++spawned, spawn(...args)));
      const decoder = new TSDecoder({ output, command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`, withArgs: true, startupTimeout: 200 });
      const timer = setInterval(() => decoder.write(Buffer.from("ts")), 50);
      try {
        while (chunks.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.strictEqual(spawned, 2);
        assert.strictEqual(Buffer.concat(chunks).toString().startsWith("ts"), true);
      } finally {
        clearInterval(timer);
        mock.restoreAll();
        decoder.end();
      }
    });

    it("closes the stream instead of passing through when the process keeps failing", { timeout: 20000 }, async () => {
      const chunks = [];
      const output = new Writable({ write: (chunk, encoding, callback) => { chunks.push(chunk); callback(); } });
      const decoder = new TSDecoder({ output, command: `"${process.execPath}" -e "process.exit(1)"`, withArgs: true, passThroughOnFailure: false });
      const closed = new Promise(resolve => decoder.once("close", resolve));
      const timer = setInterval(() => decoder.writable && decoder.write(Buffer.from("tlv")), 100);
      await closed;
      clearInterval(timer);
      assert.strictEqual(output.writableEnded, true);
      assert.strictEqual(chunks.length, 0);
    });
  });

  describe("Tuner: output format", () => {
    before(() => {
      _.channel = { getStreams: () => [] };
    });
    const bs4k = () => new ChannelItem({ name: "BS4K", type: "BS4K", channel: "1" });
    const gr = () => new ChannelItem({ name: "GR", type: "GR", channel: "27" });

    it("is TS for the TS channels and rejects TLV", () => {
      const t = tuner([fakeDevice(0, { types: ["GR"] })]);
      assert.strictEqual(t.getOutputFormat([{ channel: gr() }]), "ts");
      assert.strictEqual(t.getOutputFormat([{ channel: gr() }], "ts"), "ts");
      assert.strictEqual(t.getOutputFormat([{ channel: gr() }], "tlv"), null);
    });

    it("is TLV by default, and TS when requested and a tuner can convert TLV to TS", () => {
      const t = tuner([fakeDevice(0, { types: ["BS4K"] }), fakeDevice(1, { types: ["BS4K"], tlvToTsDecoder: "mmt2ts" })]);
      assert.strictEqual(t.getOutputFormat([{ channel: bs4k() }]), "tlv");
      assert.strictEqual(t.getOutputFormat([{ channel: bs4k() }], "ts"), "ts");
    });

    it("is TLV by default and rejects TS without tlvToTsDecoder", () => {
      const t = tuner([fakeDevice(0, { types: ["BS4K"] })]);
      assert.strictEqual(t.getOutputFormat([{ channel: bs4k() }]), "tlv");
      assert.strictEqual(t.getOutputFormat([{ channel: bs4k() }], "ts"), null);
    });

    it("follows defaultTlvStreamFormat", () => {
      const t = tuner([fakeDevice(0, { types: ["BS4K"], tlvToTsDecoder: "mmt2ts" })]);
      _.config = { server: { defaultTlvStreamFormat: "ts" } };
      assert.strictEqual(t.getOutputFormat([{ channel: bs4k() }]), "ts");
      _.config = { server: {} };
    });

    it("considers all the channels of the stream, not only the first one", () => {
      const t = tuner([fakeDevice(0, { types: ["GR", "BS4K"] })]);
      // the channel of TS outputs TS without tlvToTsDecoder
      assert.strictEqual(t.getOutputFormat([{ channel: bs4k() }, { channel: gr() }], "ts"), "ts");
      assert.strictEqual(t.getOutputFormat([{ channel: gr() }, { channel: bs4k() }]), "tlv");
      assert.strictEqual(t.getOutputFormat([{ channel: gr() }, { channel: bs4k() }], "tlv"), "tlv");
    });

    describe("the channel picked", () => {
      function streamingDevice(index, config) {
        const device = fakeDevice(index, config);
        device.isRemote = false;
        device.decoder = null;
        device.startStream = async (user, filter, channel) => {
          device.started = { filter, channel };
        };
        return device;
      }
      function user(outputFormat, channel) {
        return { id: "user", priority: 0, disableDecoder: true, outputFormat, streamSetting: { channel } };
      }

      it("outputs TLV only from the channels of TLV", async () => {
        const device = streamingDevice(0, { types: ["GR", "BS4K"] });
        const t = tuner([device]);
        const channels = [gr(), bs4k()];
        const filter = await t._initTS(user("tlv", channels[0]), new PassThrough(), t._getCandidates(channels.map(channel => ({ channel }))));
        assert.strictEqual(device.started.channel, channels[1]);
        assert.ok(filter instanceof TLVFilter);
        filter.close();
      });

      it("outputs TS from the channels of TS, and from TLV only by the tuners with tlvToTsDecoder", async () => {
        const device = streamingDevice(0, { types: ["GR", "BS4K"] });
        const t = tuner([device]);
        const channels = [bs4k(), gr()];
        const filter = await t._initTS(user("ts", channels[0]), new PassThrough(), t._getCandidates(channels.map(channel => ({ channel }))));
        assert.strictEqual(device.started.channel, channels[1]);
        assert.ok(!(filter instanceof TLVFilter));
        filter.close();
      });
    });
  });

  describe("stream API", () => {
    let server;
    let port;
    before(async () => {
      const op = require("../lib/Mirakurun/api/channels/{type}/{channel}/stream");
      const channels = { BS4K: bs4kChannel(), GR: new ChannelItem({ name: "GR", type: "GR", channel: "27" }) };
      function bs4kChannel() {
        const ch = new ChannelItem({ name: "BS4K", type: "BS4K", channel: "1" });
        return ch;
      }
      _.channel = { get: type => channels[type] || null, getStreams: () => [] };
      _.tuner = tuner([fakeDevice(0, { types: ["GR", "BS4K"], tlvToTsDecoder: "mmt2ts" })]);
      _.tuner.initChannelStream = async (ch, userReq, output) => {
        const filter = new EventEmitter();
        filter.close = () => output.end();
        setImmediate(() => output.end(userReq.outputFormat));
        return filter;
      };

      const app = express();
      app.get("/:type/:channel", op.get);
      app.head("/:type/:channel", op.head);
      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      port = server.address().port;
    });
    after(() => server.close());

    function request(method, url) {
      return new Promise((resolve, reject) => {
        http.request({ host: "127.0.0.1", port, method, path: url }, res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks).toString() }));
        }).on("error", reject).end();
      });
    }

    it("responds the same Content-Type for GET and HEAD", async () => {
      for (const [url, type, format] of [
        ["/BS4K/1", "application/octet-stream", "tlv"],
        ["/BS4K/1?format=ts", "video/MP2T", "ts"],
        ["/GR/27", "video/MP2T", "ts"]
      ]) {
        const get = await request("GET", url);
        const head = await request("HEAD", url);
        assert.deepStrictEqual([get.status, get.type, get.body], [200, type, format], url);
        assert.deepStrictEqual([head.status, head.type], [200, type], url);
      }
    });

    it("responds 406 for the unavailable format for both GET and HEAD", async () => {
      assert.strictEqual((await request("GET", "/GR/27?format=tlv")).status, 406);
      assert.strictEqual((await request("HEAD", "/GR/27?format=tlv")).status, 406);
    });
  });

  describe("IPTV", () => {
    let playlist;
    let lineup;
    before(() => {
      const Service = require("../lib/Mirakurun/Service").default;
      Service.isLogoDataExists = async () => false;
      playlist = require("../lib/Mirakurun/api/iptv/playlist");
      lineup = require("../lib/Mirakurun/api/iptv/lineup.json");
      _.channel = { getStreams: () => [] };
      const service = (id, type, channel) => ({
        id, serviceId: id, networkId: 1, logoId: -1, remoteControlKeyId: 0, name: `s${id}`, type, getOrder: () => id,
        channel, targets: [{ channel }]
      });
      _.service = {
        items: [
          service(1, 0x01, new ChannelItem({ name: "GR", type: "GR", channel: "27" })),
          service(2, 0xAD, new ChannelItem({ name: "BS4K", type: "BS4K", channel: "1" }))
        ]
      };
    });

    async function get(op) {
      const req = { protocol: "http", headers: { host: "mirakurun" } };
      const res = new PassThrough();
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.setHeader = () => {};
      res.status = () => res;
      const ended = new Promise(resolve => res.once("end", resolve));
      await op.get(req, res);
      await ended;
      return Buffer.concat(chunks).toString();
    }

    it("requests TS for the services of TLV", async () => {
      _.tuner = tuner([fakeDevice(0, { types: ["GR", "BS4K"], tlvToTsDecoder: "mmt2ts" })]);
      const m3u = await get(playlist);
      assert.ok(m3u.includes("http://mirakurun/api/services/1/stream\n"), m3u);
      assert.ok(m3u.includes("http://mirakurun/api/services/2/stream?format=ts\n"), m3u);
      const channels = JSON.parse(await get(lineup));
      assert.deepStrictEqual(channels.map(c => c.URL), [
        "http://mirakurun/api/services/1/stream",
        "http://mirakurun/api/services/2/stream?format=ts"
      ]);
    });

    it("does not list the services of TLV without tlvToTsDecoder", async () => {
      _.tuner = tuner([fakeDevice(0, { types: ["GR", "BS4K"] })]);
      const m3u = await get(playlist);
      assert.ok(m3u.includes("/services/1/stream"), m3u);
      assert.ok(!m3u.includes("/services/2/"), m3u);
      const channels = JSON.parse(await get(lineup));
      assert.deepStrictEqual(channels.map(c => c.URL), ["http://mirakurun/api/services/1/stream"]);
    });
  });
});

describe("[tlv.spec] format detection", () => {
  let detectStreamFormat;
  let ChannelItem;
  let Tuner;
  const _ = require("../lib/Mirakurun/_").default;
  before(() => {
    ({ detectStreamFormat } = require("../lib/Mirakurun/StreamFormat"));
    ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
    Tuner = require("../lib/Mirakurun/Tuner").default;
  });

  function tsData(bytes) {
    const d = Buffer.alloc(bytes, 0x7F);
    for (let i = 0; i + 188 <= d.length; i += 188) {
      d[i] = 0x47;
    }
    return d;
  }

  function tlvData(bytes) {
    const packets = [];
    let total = 0;
    while (total < bytes) {
      const p = Buffer.alloc(4 + 500, 0x47);
      p[0] = 0x7F;
      p[1] = 0x03;
      p.writeUInt16BE(500, 2);
      packets.push(p);
      total += p.length;
    }
    return Buffer.concat(packets).subarray(0, bytes);
  }

  it("detects TS and TLV regardless of the start of the data", () => {
    assert.strictEqual(detectStreamFormat(tsData(65536).subarray(100)), "ts");
    assert.strictEqual(detectStreamFormat(tlvData(65536).subarray(100)), "tlv");
    assert.strictEqual(detectStreamFormat(Buffer.alloc(65536, 0x55)), null);
  });

  it("uses `format` of channels.yml, the format detected, then the default of the type", () => {
    _.channel = { getStreams: () => [] };
    assert.strictEqual(new ChannelItem({ name: "GR", type: "GR", channel: "27" }).format, "ts");
    assert.strictEqual(new ChannelItem({ name: "BS4K", type: "BS4K", channel: "1" }).format, "tlv");
    assert.strictEqual(new ChannelItem({ name: "GR", type: "GR", channel: "27", format: "tlv" }).format, "tlv");

    _.channel = { getStreams: () => [{ networkId: 1, streamId: 1, format: "tlv" }] };
    assert.strictEqual(new ChannelItem({ name: "GR", type: "GR", channel: "27" }).format, "tlv");
    assert.strictEqual(new ChannelItem({ name: "GR", type: "GR", channel: "27", format: "ts" }).format, "ts");
  });

  it("detects the format by joining the tuner of the scan, the data may be of the channel tuned before", async () => {
    _.channel = { getStreams: () => [] };
    _.config = { server: {} };
    const channel = new ChannelItem({ name: "GR", type: "GR", channel: "27" });
    const streamSetting = { channel };
    const device = {
      index: 0, config: { name: "t", types: ["GR"], tlvToTsDecoder: "mmt2ts" }, isAvailable: true, isRemote: false, channel,
      users: [{ id: "scan", streamSetting }],
      async startStream(user, sink, ch) {
        this.started = { user, ch };
        // 選局し直す前のチャンネル (TLV) のデータが先頭に残っている
        setImmediate(() => {
          sink.write(tlvData(30000));
          sink.write(tsData(188 * 1000));
        });
      }
    };
    const t = Object.create(Tuner.prototype);
    t._devices = [device];

    const probe = t._startFormatProbe({ id: "scan", priority: -1, streamSetting });
    assert.deepStrictEqual(await probe.detected, { format: "ts", tsmf: null });
    // joins the stream without tuning
    assert.deepStrictEqual([device.started.user.id, device.started.ch], ["scan#format", undefined]);
  });

  it("does not detect the format on the tuners only for TS", () => {
    const channel = new ChannelItem({ name: "BS", type: "BS", channel: "BS01_0" });
    const t = Object.create(Tuner.prototype);
    for (const config of [{ types: ["GR", "BS", "CS"] }, { types: ["BS4K"] }, { types: ["BS"], tlvDecoder: "dec" }]) {
      const streamSetting = { channel };
      const device = {
        config: { name: "t", ...config }, isRemote: false, users: [{ id: "scan", streamSetting }],
        async startStream(user) { this.started = user; }
      };
      t._devices = [device];
      const probe = t._startFormatProbe({ id: "scan", priority: -1, streamSetting });
      const forTlv = !!config.tlvDecoder || config.types.includes("BS4K");
      assert.strictEqual(probe !== null, forTlv, JSON.stringify(config));
      assert.strictEqual(device.started !== undefined, forTlv, JSON.stringify(config));
      probe?.end();
    }
  });

  it("joins the tuner of its own scan, not of the other scan with the same ID", () => {
    const user = name => ({ id: "Mirakurun:getServices()", priority: -1, streamSetting: { channel: new ChannelItem({ name, type: "BS", channel: name }) } });
    const device = u => ({
      config: { name: "t", types: ["BS", "BS4K"] }, isRemote: false, users: [{ id: u.id, streamSetting: u.streamSetting }],
      async startStream(probeUser) { this.joined = probeUser; }
    });
    const [userA, userB] = [user("A"), user("B")];
    const [deviceA, deviceB] = [device(userA), device(userB)];
    const t = Object.create(Tuner.prototype);
    t._devices = [deviceB, deviceA];
    t._startFormatProbe(userA).end();
    assert.strictEqual(deviceA.joined?.streamSetting, userA.streamSetting);
    assert.strictEqual(deviceB.joined, undefined);
  });

  describe("service scan", () => {
    function scanner(detected, detectDelay = 10) {
      const t = Object.create(Tuner.prototype);
      t._devices = [];
      t.formats = [];
      t._initTS = async (user, dest, candidates) => {
        const { format } = candidates[0];
        t.formats.push(format);
        const filter = new EventEmitter();
        filter.closed = false;
        filter.close = () => {
          if (!filter.closed) {
            filter.closed = true;
            filter.emit("close");
          }
        };
        // TLVFilter に TS を、TSFilter に TLV を渡した場合はサービスが見つからない
        if (format === (detected || format)) {
          setTimeout(() => {
            filter.emit("network", { networkId: 1, areaCode: -1, remoteControlKeyId: -1 });
            filter.emit("services", [{ networkId: 1, serviceId: 101, streamId: 1 }]);
          }, 50);
        }
        return filter;
      };
      t._startFormatProbe = () => {
        t.probed = (t.probed || 0) + 1;
        return {
          detected: new Promise(resolve => setTimeout(() => resolve(detected && { format: detected, tsmf: null }), detectDelay)),
          tsmf: false,
          end: () => t.probeEnded = true
        };
      };
      return t;
    }

    before(() => {
      _.channel = { get: () => null, getStreams: () => [] };
    });

    it("does not wait for the format detection, and does not scan again for the format of the channel", async () => {
      const t = scanner("ts", 1000);
      const startedAt = Date.now();
      const services = await t.getServices(new ChannelItem({ name: "GR", type: "GR", channel: "27" }));
      assert.ok(Date.now() - startedAt < 500);
      assert.deepStrictEqual(services.map(s => s.serviceId), [101]);
      assert.deepStrictEqual(t.formats, ["ts"]);
      assert.strictEqual(t.probeEnded, true);
    });

    it("scans again in the format detected", async () => {
      const t = scanner("tlv");
      const services = await t.getServices(new ChannelItem({ name: "BS", type: "BS", channel: "BS01_0" }));
      assert.deepStrictEqual(services.map(s => s.serviceId), [101]);
      assert.deepStrictEqual(t.formats, ["ts", "tlv"]);
      assert.strictEqual(t.probed, 1);
    });

    it("does not scan again when the scan has succeeded before the detection", async () => {
      // the services are found right after the start, the detection comes at 50ms
      const t = scanner("tlv", 50);
      t._initTS = (init => async (...args) => {
        const filter = await init(...args);
        setTimeout(() => {
          filter.emit("network", { networkId: 1, areaCode: -1, remoteControlKeyId: -1 });
          filter.emit("services", [{ networkId: 1, serviceId: 101, streamId: 1 }]);
        }, 0);
        return filter;
      })(t._initTS);
      const services = await t.getServices(new ChannelItem({ name: "GR", type: "GR", channel: "27" }));
      assert.deepStrictEqual(services.map(s => s.serviceId), [101]);
      assert.deepStrictEqual(t.formats, ["ts"]);
    });

    it("uses the format of the channel when it is not detected", async () => {
      const t = scanner(null);
      const services = await t.getServices(new ChannelItem({ name: "BS4K", type: "BS4K", channel: "1" }));
      assert.deepStrictEqual(services.map(s => s.serviceId), [101]);
      assert.deepStrictEqual(t.formats, ["tlv"]);
    });
  });
});
