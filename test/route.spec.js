const { describe, it, before, after, beforeEach, afterEach, mock } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const child_process = require("child_process");

// status.ts のタイマーでテストのプロセスが終了しなくなるため差し替える
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
require.cache[statusPath] = {
  id: statusPath,
  filename: statusPath,
  loaded: true,
  exports: { __esModule: true, default: { epg: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { tunerDeviceRespawn: 0 } } }
};

// koffi を使わずに DVB デバイスの直接操作を初期化する
class FakeDvb extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.path = `/dev/dvb/adapter${options.adapter}`;
    this.isOpen = false;
    this.started = [];
  }
  async start(params) {
    this.isOpen = true;
    this.started.push(params.properties[0][1]);
  }
  async stopStream() {}
  async close() {
    this.isOpen = false;
  }
}
const dvbDevicePath = path.join(__dirname, "../lib/Mirakurun/dvb/DvbDevice.js");
require.cache[dvbDevicePath] = {
  id: dvbDevicePath,
  filename: dvbDevicePath,
  loaded: true,
  exports: { __esModule: true, default: FakeDvb }
};

const log = require("../lib/Mirakurun/log");
const _ = require("../lib/Mirakurun/_").default;
const db = require("../lib/Mirakurun/db");
let Channel;
let ChannelItem;
let Service;
let Tuner;
let TunerDevice;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-route-"));
const flush = () => new Promise(resolve => setImmediate(resolve));

// 4.2.1 の services.json (streamId がない)
function writeLegacyServices(services) {
  fs.writeFileSync(process.env.SERVICES_DB_PATH, JSON.stringify([{ __integrity__: "test" }, ...services]));
}

function setupChannels(channels) {
  _.config = { server: { disableEITParsing: true }, channels };
  _.tuner = { typeExists: () => true };
  _.channel = new Channel();
  _.service = new Service();
}

function fakeDevice(index, types, routes, state = {}) {
  return {
    index,
    config: { name: `tuner${index}`, types, routes },
    isAvailable: true,
    isFree: true,
    isUsing: false,
    users: [],
    channel: null,
    getPriority: () => -2,
    ...state
  };
}

function tuner(devices) {
  const t = Object.create(Tuner.prototype);
  t._devices = devices;
  t._readyForJobPickedDeviceSet = new Set();
  return t;
}

describe("[route.spec] route / streamId", () => {
  before(() => {
    for (const level of ["info", "debug", "warn", "error", "fatal"]) {
      log[level] = () => {};
    }
    process.env.CHANNELS_DB_PATH = path.join(dir, "channels.json");
    process.env.SERVICES_DB_PATH = path.join(dir, "services.json");
    _.configIntegrity = { channels: "test" };
    _.event = { emit: () => true };
    Channel = require("../lib/Mirakurun/Channel").default;
    ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
    Service = require("../lib/Mirakurun/Service").default;
    Tuner = require("../lib/Mirakurun/Tuner").default;
    TunerDevice = require("../lib/Mirakurun/TunerDevice").default;
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  describe("ChannelItem", () => {
    it("defaults the route by the type and keeps the config properties in toJSON()", () => {
      setupChannels([]);
      const gr = new ChannelItem({ name: "GR27", type: "GR", channel: "27", commandVars: { freq: 1 } });
      const bs = new ChannelItem({ name: "BS15", type: "BS", channel: "BS31_0", tsmfRelTs: 2 });
      const catv = new ChannelItem({ name: "C45", type: "BS", channel: "C45", route: "CATV" });

      assert.deepStrictEqual([gr.route, bs.route, catv.route], ["TER", "SAT", "CATV"]);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(gr)), {
        name: "GR27", type: "GR", channel: "27", route: "TER", commandVars: { freq: 1 }
      });
      assert.strictEqual(bs.toJSON().tsmfRelTs, 2);
    });
  });

  describe("Service: migration from 4.2.1", () => {
    it("keeps the services without streamId on their channel until scanned", async () => {
      setupChannels([{ name: "GR27", type: "GR", channel: "27" }]);
      writeLegacyServices([
        { id: 3275201024, serviceId: 1024, networkId: 32752, name: "A", type: 1, channel: { type: "GR", channel: "27" } },
        // channels.yml から消えたチャンネルのサービスは、4.2.1 と同じく破棄する
        { id: 3275201025, serviceId: 1025, networkId: 32752, name: "B", type: 1, channel: { type: "GR", channel: "99" } }
      ]);
      await _.channel.load();
      await _.service.load();

      assert.deepStrictEqual(_.service.items.map(item => item.serviceId), [1024]);
      const service = _.service.get(32752, 1024);
      assert.strictEqual(service.streamId, undefined);
      assert.strictEqual(service.channel, _.channel.get("GR", "27"));
      assert.deepStrictEqual(_.service.findByChannel(_.channel.get("GR", "27")), [service]);
    });

    it("scans the channels of the migrated services first", async () => {
      setupChannels([{ name: "GR27", type: "GR", channel: "27" }]);
      writeLegacyServices([
        { id: 3275201024, serviceId: 1024, networkId: 32752, name: "A", type: 1, channel: { type: "GR", channel: "27" } }
      ]);
      await _.channel.load();
      await _.service.load();

      const jobs = [];
      _.job = { add: job => jobs.push(job), addSchedule: () => {}, jobs: [] };
      await _.service._initJobs();

      assert.strictEqual(jobs[0].key, "Service.Update.Scan.GR.27");
    });

    it("sets streamId by the scan and saves services.json that 4.2.1 can load", async () => {
      setupChannels([
        { name: "BS15", type: "BS", channel: "BS31_0" },
        { name: "C45", type: "BS", channel: "C45", route: "CATV" }
      ]);
      writeLegacyServices([
        { id: 400701, serviceId: 701, networkId: 4, name: "Test BS", type: 1, channel: { type: "BS", channel: "BS31_0" } }
      ]);
      await _.channel.load();
      await _.service.load();

      const scanned = [{ networkId: 4, serviceId: 701, streamId: 20225, name: "Test BS", type: 1, logoId: -1, remoteControlKeyId: 1 }];
      // Tuner.getServices() saves the stream received on the channel
      _.tuner.getServices = async ch => {
        ch.setStream(4, 20225, "ts");
        return scanned;
      };
      await _.service._scan(_.channel.get("BS", "BS31_0"), false);
      // 同じストリームを受信できる別の経路
      await _.service._scan(_.channel.get("BS", "C45"), false);

      const service = _.service.get(4, 701);
      assert.strictEqual(service.streamId, 20225);
      assert.deepStrictEqual(service.channels.map(ch => ch.channel), ["BS31_0", "C45"]);
      assert.deepStrictEqual(_.service.findByChannel(_.channel.get("BS", "C45")), [service]);

      let saved;
      mock.method(db, "saveServices", async data => saved = data);
      let savedChannels;
      mock.method(db, "saveChannels", async data => savedChannels = data);
      mock.timers.tick(1000 * 10);

      assert.deepStrictEqual(saved.map(({ channel, streamId, channels }) => ({ channel, streamId, channels })), [{
        channel: { type: "BS", channel: "BS31_0", route: "SAT" },
        streamId: 20225,
        channels: undefined
      }]);
      assert.deepStrictEqual(savedChannels, [
        { type: "BS", channel: "BS31_0", streams: [{ networkId: 4, streamId: 20225, format: "ts" }] },
        { type: "BS", channel: "C45", streams: [{ networkId: 4, streamId: 20225, format: "ts" }] }
      ]);
    });

    it("restores the channels of the stream from channels.json", async () => {
      setupChannels([
        { name: "BS15", type: "BS", channel: "BS31_0" },
        { name: "C45", type: "BS", channel: "C45", route: "CATV" }
      ]);
      fs.writeFileSync(process.env.CHANNELS_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { type: "BS", channel: "BS31_0", streams: [{ networkId: 4, streamId: 20225, format: "ts" }] },
        { type: "BS", channel: "C45", streams: [{ networkId: 4, streamId: 20225, format: "ts", relTs: 1, slots: 44 }] }
      ]));
      fs.writeFileSync(process.env.SERVICES_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { id: 400701, serviceId: 701, networkId: 4, streamId: 20225, name: "Test BS", type: 1, channel: { type: "BS", channel: "BS31_0" } }
      ]));
      await _.channel.load();
      await _.service.load();

      assert.deepStrictEqual(_.service.get(4, 701).channels.map(ch => ch.channel), ["BS31_0", "C45"]);
      assert.deepStrictEqual(_.service.get(4, 701).export().channels, [
        { type: "BS", channel: "BS31_0", route: "SAT" },
        { type: "BS", channel: "C45", route: "CATV" }
      ]);
    });

    it("restores the stream saved in the format before the relative streams of TSMF", async () => {
      setupChannels([
        { name: "BS15", type: "BS", channel: "BS31_0" },
        { name: "C45", type: "BS", channel: "C45", route: "CATV" },
        { name: "C46", type: "BS", channel: "C46", route: "CATV", tsmfRelTs: 3 }
      ]);
      fs.writeFileSync(process.env.CHANNELS_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { type: "BS", channel: "BS31_0", networkId: 4, streamId: 20225, format: "ts" },
        { type: "BS", channel: "C45", networkId: 4, streamId: 20225 },
        { type: "BS", channel: "C46", networkId: 11, streamId: 45168, format: "tlv" }
      ]));
      fs.writeFileSync(process.env.SERVICES_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { id: 400701, serviceId: 701, networkId: 4, streamId: 20225, name: "Test BS", type: 1, channel: { type: "BS", channel: "BS31_0" } }
      ]));
      await _.channel.load();
      await _.service.load();

      assert.deepStrictEqual(_.channel.get("BS", "BS31_0").streams, [{ networkId: 4, streamId: 20225, format: "ts" }]);
      // the stream of the channel with tsmfRelTs is of the relative stream
      const c46 = _.channel.get("BS", "C46");
      assert.deepStrictEqual(c46.stream, { networkId: 11, streamId: 45168, format: "tlv", relTs: 3 });
      assert.strictEqual(c46.format, "tlv");
      assert.deepStrictEqual(_.service.get(4, 701).channels.map(ch => ch.channel), ["BS31_0", "C45"]);
    });

    it("uses the channel of services.json when the stream is not in channels.json", async () => {
      setupChannels([{ name: "BS15", type: "BS", channel: "BS31_0" }]);
      fs.writeFileSync(process.env.CHANNELS_DB_PATH, JSON.stringify([{ __integrity__: "test" }]));
      fs.writeFileSync(process.env.SERVICES_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { id: 400701, serviceId: 701, networkId: 4, streamId: 20225, name: "Test BS", type: 1, channel: { type: "BS", channel: "BS31_0" } }
      ]));
      await _.channel.load();
      await _.service.load();

      assert.deepStrictEqual(_.service.get(4, 701).channels.map(ch => ch.channel), ["BS31_0"]);
    });
  });

  it("updates the channel index after route, stream and service changes without exposing its arrays", () => {
    setupChannels([
      { name: "BS", type: "BS", channel: "BS31_0" },
      { name: "CATV", type: "BS", channel: "C45", route: "CATV" }
    ]);
    const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
    const sat = _.channel.get("BS", "BS31_0");
    const catv = _.channel.get("BS", "C45");
    const service = new ServiceItem(sat, 4, 701, "A", 1, -1, undefined, false, 0, 20225);
    _.service.add(service);
    assert.deepStrictEqual(_.service.findByChannel(catv), []);
    catv.setStream(4, 20225);
    assert.deepStrictEqual(_.service.findByChannel(catv), [service]);
    _.service.findByChannel(catv).length = 0;
    assert.deepStrictEqual(_.service.findByChannel(catv), [service]);
    catv.setStream(4, 20226);
    assert.deepStrictEqual(_.service.findByChannel(catv), []);
    service.streamId = 20226;
    assert.deepStrictEqual(_.service.findByChannel(catv), [service]);
    const added = new ServiceItem(catv, 4, 102, "B", 1, -1, undefined, false, 0, 20226);
    _.service.add(added);
    assert.deepStrictEqual(_.service.findByChannel(catv), [service, added]);
  });

  it("updates service ordering after a remote control key changes", () => {
    setupChannels([{ name: "GR27", type: "GR", channel: "27" }]);
    const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
    const channel = _.channel.get("GR", "27");
    const a = new ServiceItem(channel, 32752, 1001, "A", 1, -1);
    const b = new ServiceItem(channel, 32752, 1002, "B", 1, -1, 5);
    const ordered = () => [a, b].sort((x, y) => x.getOrder() - y.getOrder());
    assert.deepStrictEqual(ordered(), [b, a]);
    assert.deepStrictEqual(ordered(), [b, a]);
    a.remoteControlKeyId = 2;
    assert.deepStrictEqual(ordered(), [a, b]);
    a.remoteControlKeyId = undefined;
    assert.deepStrictEqual(ordered(), [b, a]);
  });

  describe("Tuner: route", () => {
    it("picks only the tuners of the route", () => {
      setupChannels([]);
      const t = tuner([fakeDevice(0, ["BS"], ["SAT"]), fakeDevice(1, ["BS"], ["CATV"]), fakeDevice(2, ["GR"])]);

      assert.strictEqual(t.typeExists("BS", "CATV"), true);
      assert.strictEqual(t.typeExists("BS", "HIKARI"), false);
      // routes を省略したチューナーは、すべての経路を受信できる
      assert.strictEqual(t.typeExists("GR", "CATV"), true);
      assert.deepStrictEqual(t._getDevicesByType("BS", "CATV").map(d => d.index), [1]);
      assert.deepStrictEqual(t._getDevicesByType("BS").map(d => d.index), [0, 1]);
    });

    it("joins the tuner already receiving another candidate channel before starting a new one", () => {
      setupChannels([]);
      const sat = new ChannelItem({ name: "BS15", type: "BS", channel: "BS31_0" });
      const catv = new ChannelItem({ name: "C45", type: "BS", channel: "C45", route: "CATV" });
      const t = tuner([
        fakeDevice(0, ["BS"], ["SAT"]),
        fakeDevice(1, ["BS"], ["CATV"], { isFree: false, isUsing: true, users: [{}], channel: catv })
      ]);

      const picked = t._pickTunerDevice(t._getCandidates([{ channel: sat }, { channel: catv }]), 0);
      assert.deepStrictEqual([picked.device.index, picked.channel], [1, catv]);
    });
  });

  describe("Tuner: readyForJob()", () => {
    it("returns the first candidate at once when a tuner is free", async () => {
      setupChannels([]);
      const gr = new ChannelItem({ name: "GR27", type: "GR", channel: "27" });
      const t = tuner([fakeDevice(0, ["GR"])]);

      assert.strictEqual(await t.readyForJob(gr), gr);
      // 選んだチューナーは 5 秒間ほかのジョブに選ばれない
      assert.strictEqual(t._readyForJobPickedDeviceSet.size, 1);
      mock.timers.tick(1000 * 5);
      assert.strictEqual(t._readyForJobPickedDeviceSet.size, 0);
    });

    it("returns another candidate at once when the tuners of the first one are busy", async () => {
      setupChannels([]);
      const sat = new ChannelItem({ name: "BS15", type: "BS", channel: "BS31_0" });
      const catv = new ChannelItem({ name: "C45", type: "BS", channel: "C45", route: "CATV" });
      const t = tuner([
        fakeDevice(0, ["BS"], ["SAT"], { isAvailable: false, isFree: false, isUsing: true, users: [{}] }),
        fakeDevice(1, ["BS"], ["CATV"])
      ]);

      assert.strictEqual(await t.readyForJob([sat, catv]), catv);
    });

    it("waits 10 seconds and retries when all the candidates are busy", async () => {
      setupChannels([]);
      const gr = new ChannelItem({ name: "GR27", type: "GR", channel: "27" });
      const busy = fakeDevice(0, ["GR"], undefined, { isAvailable: false, isFree: false, isUsing: true, users: [{}] });
      const t = tuner([busy]);

      let result;
      t.readyForJob(gr).then(ch => result = ch);
      await flush();
      assert.strictEqual(result, undefined);

      Object.assign(busy, { isAvailable: true, isFree: true, isUsing: false, users: [] });
      mock.timers.tick(1000 * 10);
      await flush();
      assert.strictEqual(result, gr);
    });

    it("returns null when no tuners can receive the channels", async () => {
      setupChannels([]);
      const catv = new ChannelItem({ name: "C45", type: "BS", channel: "C45", route: "CATV" });
      const t = tuner([fakeDevice(0, ["BS"], ["SAT"])]);

      assert.strictEqual(await t.readyForJob(catv), null);
    });
  });

  describe("Channel: EPG gathering", () => {
    it("gathers EPG on the channel picked by readyFn without waiting for the tuner again", async () => {
      setupChannels([{ name: "GR27", type: "GR", channel: "27" }]);
      writeLegacyServices([
        { id: 3275201024, serviceId: 1024, networkId: 32752, name: "A", type: 1, channel: { type: "GR", channel: "27" } }
      ]);
      await _.channel.load();
      await _.service.load();

      const jobs = [];
      _.job = { add: job => jobs.push(job) };
      _.program = { findByNetworkIdAndTime: () => [], findByNetworkId: () => [] };
      const t = tuner([fakeDevice(0, ["GR"])]);
      const gathered = [];
      t.getEPG = async ch => gathered.push(ch);
      _.tuner = t;
      const readyForJob = mock.method(t, "readyForJob");

      await _.channel._epgGatherer();
      const job = jobs.find(j => j.key === "EPG.Gather.NID.32752");
      const ready = job.readyFn();
      mock.timers.tick(100);
      assert.strictEqual(await ready, true);
      // readyFn がチューナーを保持している間でも、待たずに始める (チューナーが 1 台の場合)
      await job.fn();

      assert.deepStrictEqual(gathered, [_.channel.get("GR", "27")]);
      assert.strictEqual(readyForJob.mock.callCount(), 1);
    });
  });

  describe("TunerDevice: <route>", () => {
    const confs = { ter: 557142857, catv: 189000000 };
    before(() => {
      for (const [route, frequency] of Object.entries(confs)) {
        fs.writeFileSync(path.join(dir, `dvbv5_channels_${route}.conf`), [
          "[27]", "\tDELIVERY_SYSTEM = ISDBT", `\tFREQUENCY = ${frequency}`, "\tBANDWIDTH_HZ = 6000000"
        ].join("\n"));
      }
    });

    it("replaces <route> in the command with the route of the channel", async () => {
      const proc = Object.assign(new EventEmitter(), { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
      const spawn = mock.method(child_process, "spawn", () => proc);
      const device = new TunerDevice(0, { name: "t", types: ["GR"], routes: ["CATV"], command: "cmd --route <route> <channel>" });
      const stream = Object.assign(new EventEmitter(), { closed: false, write() {}, flush() {}, end() {} });
      await device.startStream({ id: "a", priority: 0 }, stream, new ChannelItem({ name: "C27", type: "GR", channel: "27", route: "CATV" }));

      assert.deepStrictEqual(spawn.mock.calls[0].arguments, ["cmd", ["--route", "catv", "27"]]);
      assert.deepStrictEqual(device.toJSON().routes, ["CATV"]);
      spawn.mock.restore();
    });

    it("accesses the DVB device directly with the channels file of each route", async () => {
      const device = new TunerDevice(0, {
        name: "dvb",
        types: ["GR"],
        routes: ["TER", "CATV"],
        command: `dvbv5-zap -a 0 -c ${path.join(dir, "dvbv5_channels_<route>.conf")} -r -P <channel>`
      });
      assert.ok(device._dvb instanceof FakeDvb);
      assert.deepStrictEqual(device._dvbChannelsConfPathByRoute, {
        TER: path.join(dir, "dvbv5_channels_ter.conf"),
        CATV: path.join(dir, "dvbv5_channels_catv.conf")
      });

      const stream = Object.assign(new EventEmitter(), { closed: false, write() {}, flush() {}, end() {} });
      await device.startStream({ id: "a", priority: 0 }, stream, new ChannelItem({ name: "C27", type: "GR", channel: "27", route: "CATV" }));
      assert.deepStrictEqual(device._dvb.started, [confs.catv]);
    });

    it("runs the command when <route> is used other than in -c", () => {
      const device = new TunerDevice(0, {
        name: "dvb",
        types: ["GR"],
        routes: ["TER", "CATV"],
        command: `dvbv5-zap -a <route> -c ${path.join(dir, "dvbv5_channels_ter.conf")} -r -P <channel>`
      });
      assert.strictEqual(device._dvb, null);
    });
  });
});


describe("channel service relative TS references", () => {
  it("distinguishes services on different relative streams of one carrier", () => {
    const { getChannelServices } = require("../lib/Mirakurun/api");
    const services = [701, 702].map((serviceId, i) => ({ id: 400000 + serviceId, serviceId, networkId: 4, streamId: 20225 + i, name: "Test", type: 1 }));
    const channel = { getServices: () => services, streams: [{ networkId: 4, streamId: 20225, relTs: 2 }, { networkId: 4, streamId: 20226, relTs: 3 }] };
    assert.deepStrictEqual(getChannelServices(channel).map(s => [s.serviceId, s.tsmfRelTs]), [[701, 2], [702, 3]]);
    // tsmfRelTs of channels.yml is of the channel, not output for the services as before
    assert.ok(getChannelServices({ ...channel, tsmfRelTs: 2 }).every(s => !("tsmfRelTs" in s)));
    channel.streams = [{ networkId: 4, streamId: 20225 }];
    assert.ok(getChannelServices(channel).every(s => !("tsmfRelTs" in s)));
  });
});
