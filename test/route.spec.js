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

  describe("TSMF two-stage discovery", () => {
    for (const order of [[0, 1, 2], [2, 0, 1]]) {
      it(`defers service scans until three carriers are discovered (${order})`, async () => {
        setupChannels([0, 1, 2].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` })));
        const channels = _.channel.items;
        const ready = mock.fn(async () => channels[0]);
        _.tuner.readyForJob = ready;
        _.tuner.canReceiveTsmfCarriers = () => true;
        const t = tuner([0, 1, 2].map(i => fakeDevice(i, ["BS4K"], ["CATV"])));
        const queued = mock.method(_.service, "queueDiscoveredTsmfScan", () => {});
        const scan = mock.method(t, "_scanServices", async () => [{ networkId: 32752, streamId: 60001, serviceId: 701 }]);
        const stream = i => [{ networkId: 32752, streamId: 60001, relTs: 2, format: "tlv", slots: i === 2 ? 20 : 52, groupId: 9, numberOfCarriers: 3, carrierSequence: i + (order[0] === 2 ? 1 : 0) }];
        for (const i of order.slice(0, 2)) {
          assert.deepStrictEqual(await t._scanTSMFServices(channels[i], { streamSetting: { channel: channels[i] } }, stream(i)), []);
          assert.strictEqual(scan.mock.callCount(), 0);
          assert.strictEqual(channels[i].tsmfGroupId, 9);
          assert.strictEqual(channels[i].toJSON().tsmfGroupId, undefined);
          await _.service._readyForScan(channels[i]);
          assert.strictEqual(ready.mock.calls.at(-1).arguments[0], channels[i]);
        }
        const last = order[2];
        const result = await t._scanTSMFServices(channels[last], { streamSetting: { channel: channels[last] } }, stream(last));
        assert.strictEqual(result[0].serviceId, 701);
        assert.strictEqual(scan.mock.callCount(), 1);
        // the services of the TLV are scanned by this carrier, the other carriers do not scan it again
        assert.strictEqual(queued.mock.callCount(), 0);
        assert.deepStrictEqual(channels[last].streams[0], { ...stream(last)[0], tsmfNetworkId: 32752, tsmfStreamId: 60001 });
        assert.strictEqual(channels[last].getBondedChannels().length, 3);
        await _.service._readyForScan(channels[last]);
        assert.deepStrictEqual(ready.mock.calls.at(-1).arguments[0], [{ channel: channels[last], relTs: 2 }]);
      });
    }

    it("does not assemble duplicate carrier sequences or unrelated streams sharing a group ID", async () => {
      setupChannels([0, 1, 2].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` })));
      const channels = _.channel.items;
      const t = tuner([]);
      t.canReceiveTsmfCarriers = () => true;
      const scan = mock.method(t, "_scanServices", async () => { throw new Error("must not scan incomplete group"); });
      const streams = channels.map((c, i) => [{ networkId: 32752, streamId: i === 2 ? 60002 : 60001, relTs: 2, format: "tlv", slots: 52, groupId: 9, numberOfCarriers: 3, carrierSequence: 0 }]);
      for (let i = 0; i < 3; i++) {
        assert.deepStrictEqual(await t._scanTSMFServices(channels[i], { streamSetting: { channel: channels[i] } }, streams[i]), []);
      }
      streams[2][0].streamId = 60001;
      assert.deepStrictEqual(await t._scanTSMFServices(channels[2], { streamSetting: { channel: channels[2] } }, streams[2]), []);
      assert.strictEqual(scan.mock.callCount(), 0);
      scan.mock.restore();
      const validScan = mock.method(t, "_scanServices", async () => []);
      const queued = mock.method(_.service, "queueDiscoveredTsmfScan", () => {});
      await t._scanTSMFServices(channels[1], { streamSetting: { channel: channels[1] } }, streams[1].map(s => ({ ...s, carrierSequence: 1 })));
      assert.strictEqual(validScan.mock.callCount(), 0);
      const corrected = streams[2].map(s => ({ ...s, carrierSequence: 2 }));
      await t._scanTSMFServices(channels[2], { streamSetting: { channel: channels[2] } }, corrected);
      assert.strictEqual(validScan.mock.callCount(), 1);
      assert.strictEqual(queued.mock.callCount(), 2);
      await t._scanTSMFServices(channels[2], { streamSetting: { channel: channels[2] } }, corrected);
      assert.strictEqual(queued.mock.callCount(), 2);
    });

    it("scans shared TS immediately and adds the services of the deferred TLV by the scan to update", async () => {
      setupChannels([{ name: "Shared", type: "BS4K", route: "CATV", channel: "C1" }]);
      const channel = _.channel.items[0];
      const streams = [
        { networkId: 32752, streamId: 60001, relTs: 2, format: "tlv", slots: 20, groupId: 9, numberOfCarriers: 3, carrierSequence: 1 },
        { networkId: 32752, streamId: 60002, relTs: 3, format: "ts", slots: 32, groupId: 9, numberOfCarriers: 3, carrierSequence: 1 }
      ];
      const t = tuner([]);
      const scan = mock.method(t, "_scanServices", async (ch, user, format, detect, relTs) => {
        assert.strictEqual(format, "ts");
        assert.strictEqual(relTs, 3);
        return [{ networkId: 32752, streamId: 60002, serviceId: 701, name: "Example", type: 1, logoId: -1, remoteControlKeyId: 1 }];
      });
      _.tuner = { getServices: ch => t._scanTSMFServices(ch, { streamSetting: { channel: ch } }, streams) };
      await _.service._scan(channel, true);
      assert.strictEqual(scan.mock.callCount(), 1);
      assert.strictEqual(channel.getServices().length, 1);
      const jobs = [];
      _.job = { add: job => jobs.push(job) };
      _.service.queueDiscoveredTsmfScan(channel);
      assert.strictEqual(jobs.length, 1);
      assert.ok(jobs[0].key.startsWith("Service.Update.Scan."));

      // 再起動 (メモリーの状態はない) の後、搬送波がそろって TLV もスキャンした
      const items = _.service.items;
      _.service = new Service();
      _.service._items = items;
      const tlvService = { networkId: 32752, streamId: 60001, serviceId: 901, name: "8K", type: 1, logoId: -1, remoteControlKeyId: 1 };
      const tsService = { networkId: 32752, streamId: 60002, serviceId: 701, name: "Example", type: 1, logoId: -1, remoteControlKeyId: 1 };
      _.tuner = { getServices: async () => [tlvService, { ...tlvService, serviceId: 902 }, tsService] };
      await _.service._scan(channel, false);
      assert.deepStrictEqual(channel.getServices().map(service => service.serviceId).sort(), [701, 901, 902]);

      // TLV のサービスが登録された後は、これまでどおり更新のスキャンでは追加しない
      _.tuner = { getServices: async () => [tlvService, { ...tlvService, serviceId: 903 }, tsService, { ...tsService, serviceId: 702 }] };
      await _.service._scan(channel, false);
      assert.deepStrictEqual(channel.getServices().map(service => service.serviceId).sort(), [701, 901, 902]);
    });

    // channels.yml で serviceId を指定したチャンネルは、指定したサービスだけを登録する
    it("does not add the services of the TLV discovered on the channels of serviceId", async () => {
      setupChannels([{ name: "Shared", type: "BS4K", route: "CATV", channel: "C1", serviceId: 701 }]);
      const channel = _.channel.items[0];
      channel.setStreams([{ networkId: 32752, streamId: 60001, relTs: 2, format: "tlv", slots: 20, groupId: 9, numberOfCarriers: 3, carrierSequence: 1 }]);
      const tsService = { networkId: 32752, streamId: 60002, serviceId: 701, name: "Example", type: 1, logoId: -1, remoteControlKeyId: 1 };
      _.service.add(new (require("../lib/Mirakurun/ServiceItem").default)(channel, 32752, 701, "Example", 1, -1, 1, false, 0, 60002));
      _.tuner = { getServices: async () => [{ ...tsService, streamId: 60001, serviceId: 901, name: "8K" }, tsService] };
      await _.service._scan(channel, false);
      assert.deepStrictEqual(channel.getServices().map(service => service.serviceId), [701]);
    });

    for (const count of [1, 2]) {
      it(`discovers with ${count} tuners without waiting for an impossible three-carrier scan`, async () => {
        setupChannels([0, 1, 2].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` })));
        const channels = _.channel.items;
        const t = tuner(Array.from({ length: count }, (_, i) => fakeDevice(i, ["BS4K"], ["CATV"])));
        _.tuner = t;
        const ready = mock.method(t, "readyForJob", async channel => {
          assert.ok(channel instanceof ChannelItem, "must only wait for one discovery tuner");
          return channel;
        });
        const scan = mock.method(t, "_scanServices", async () => { throw new Error("TLV cannot be assembled"); });
        const queued = mock.method(_.service, "queueDiscoveredTsmfScan", () => {});
        for (let i = 0; i < channels.length; i++) {
          const streams = [{ networkId: 32752, streamId: 60001, relTs: 2, format: "tlv", slots: 52, groupId: 9, numberOfCarriers: 3, carrierSequence: i }];
          assert.deepStrictEqual(await t._scanTSMFServices(channels[i], { streamSetting: { channel: channels[i] } }, streams), []);
        }
        assert.strictEqual(scan.mock.callCount(), 0);
        assert.strictEqual(queued.mock.callCount(), 0);
        for (const channel of channels) {
          assert.strictEqual(channel.streams[0].groupId, 9);
          await _.service._readyForScan(channel);
        }
        assert.strictEqual(ready.mock.callCount(), 3);
        t._devices.push(...Array.from({ length: 3 - count }, (_, i) => fakeDevice(count + i, ["BS4K"], ["CATV"])));
        assert.strictEqual(t.canReceiveTsmfCarriers(channels[0], 3), true);
        ready.mock.restore();
        const nextReady = mock.method(t, "readyForJob", async targets => {
          assert.deepStrictEqual(targets, [{ channel: channels[0], relTs: 2 }]);
          return channels[0];
        });
        assert.strictEqual(await _.service._readyForScan(channels[0]), true);
        assert.strictEqual(nextReady.mock.callCount(), 1);
      });
    }

    // そろえた搬送波で TLV のサービスを取得できなかった場合は、ほかの搬送波でスキャンする
    it("queues the scans of the other carriers when the TLV is not scanned by the carrier completing the group", async () => {
      setupChannels([0, 1, 2].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` })));
      const channels = _.channel.items;
      const t = tuner([0, 1, 2].map(i => fakeDevice(i, ["BS4K"], ["CATV"])));
      const queued = mock.method(_.service, "queueDiscoveredTsmfScan", () => {});
      mock.method(t, "_scanServices", async () => { throw new Error("no available tuners"); });
      const stream = i => [{ networkId: 32752, streamId: 60001, relTs: 2, format: "tlv", slots: 52, groupId: 9, numberOfCarriers: 3, carrierSequence: i }];
      for (const i of [0, 1]) {
        assert.deepStrictEqual(await t._scanTSMFServices(channels[i], { streamSetting: { channel: channels[i] } }, stream(i)), []);
      }
      await assert.rejects(t._scanTSMFServices(channels[2], { streamSetting: { channel: channels[2] } }, stream(2)), /no available tuners/);

      assert.deepStrictEqual(new Set(queued.mock.calls.map(c => c.arguments[0])), new Set([channels[0], channels[1]]));
    });

    // TLV のサービスの ID (tlv_stream_id) がヘッダーと違っても、搬送波はヘッダーの ID で関連付ける
    it("keeps associating the carriers by the IDs of the header after the TLV is scanned with the different IDs", async () => {
      setupChannels([0, 1, 2].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` })));
      const channels = _.channel.items;
      const t = tuner([0, 1, 2].map(i => fakeDevice(i, ["BS4K"], ["CATV"])));
      mock.method(_.service, "queueDiscoveredTsmfScan", () => {});
      mock.method(t, "_scanServices", async () => [{ networkId: 11, streamId: 60099, serviceId: 701 }]);
      const header = i => [{ networkId: 11, streamId: 60001, relTs: 2, format: "tlv", slots: 52, groupId: 9, numberOfCarriers: 3, carrierSequence: i }];
      for (const i of [0, 1, 2]) {
        await t._scanTSMFServices(channels[i], { streamSetting: { channel: channels[i] } }, header(i));
      }

      // the stream of the services (to find the services) and the IDs of the header (to associate the carriers)
      assert.deepStrictEqual([channels[2].streams[0].streamId, channels[2].streams[0].tsmfStreamId], [60099, 60001]);
      for (const channel of channels) {
        assert.deepStrictEqual(channel.getBondedChannels(), channels);
        assert.strictEqual(channel.hasAllCarriers(channel.streams[0]), true);
      }
      const candidate = t._getCandidate(channels[2], 2);
      assert.strictEqual(t._pickCarrierDevices({ device: t._devices[2], channel: channels[2], candidate }, 0).length, 2);
    });

    // スキャンに失敗しても、前に受信したサービスのストリームの ID を残す (ヘッダーの ID で置き換えない)
    it("keeps the IDs of the services received before when the scan fails", async () => {
      setupChannels([{ name: "Shared", type: "BS4K", route: "CATV", channel: "S1" }]);
      const channel = _.channel.items[0];
      const t = tuner([fakeDevice(0, ["BS4K"], ["CATV"])]);
      const header = [
        { relTs: 1, slots: 10, format: "ts", streamId: 100, networkId: 4, groupId: 9, numberOfCarriers: 2, carrierSequence: 0 },
        { relTs: 2, slots: 42, format: "tlv", streamId: 60001, networkId: 11, groupId: 9, numberOfCarriers: 2, carrierSequence: 0 }
      ];
      let fail = false;
      mock.method(t, "_scanServices", async () => {
        if (fail) {
          throw new Error("stream has closed before get services");
        }
        return [{ networkId: 32752, streamId: 100, serviceId: 1, name: "TS", type: 1, logoId: -1, remoteControlKeyId: 1 }];
      });
      _.tuner = Object.assign(t, { getServices: ch => t._scanTSMFServices(ch, { streamSetting: { channel: ch } }, header) });
      await _.service._scan(channel, true);
      const service = _.service.items[0];
      assert.deepStrictEqual(service.targets.map(target => target.relTs), [1]);

      fail = true;
      await assert.rejects(_.service._scan(channel, false));
      assert.strictEqual(channel.getStreamByRelTs(1).networkId, 32752);
      assert.deepStrictEqual(service.targets.map(target => target.relTs), [1]);
    });

    // ヘッダーの ID とスキャンしたサービスの ID が違っても、ヘッダーが変わらなければ他の搬送波を再スキャンし続けない
    it("does not re-queue the other carriers by the IDs of the services different from the header", async () => {
      setupChannels([0, 1].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` })));
      const channels = _.channel.items;
      const t = tuner([0, 1].map(i => fakeDevice(i, ["BS4K"], ["CATV"])));
      const queued = mock.method(_.service, "queueDiscoveredTsmfScan", () => {});
      // the TS of relTs 1: original_network_id 4 in the header, 32752 in SDT
      mock.method(t, "_scanServices", async (channel, user, format, detect, relTs) => relTs === 1
        ? [{ networkId: 32752, streamId: 100, serviceId: 1 }]
        : []); // the TLV is not scanned (the other carriers scan it)
      const header = i => [
        { relTs: 1, slots: 10, format: "ts", streamId: 100, networkId: 4, groupId: 9, numberOfCarriers: 2, carrierSequence: i },
        { relTs: 2, slots: 42, format: "tlv", streamId: 60001, networkId: 11, groupId: 9, numberOfCarriers: 2, carrierSequence: i }
      ];
      for (let n = 0; n < 3; n++) {
        for (const i of [0, 1]) {
          await t._scanTSMFServices(channels[i], { streamSetting: { channel: channels[i] } }, header(i));
        }
      }
      // only when the group is completed (the scan of the second carrier)
      assert.strictEqual(queued.mock.callCount(), 1);
    });

    // 搬送波番号が重複して結合できないグループでは、スキャンのために全搬送波のチューナーを待たない
    it("does not wait for the tuners of all the carriers when the carrier sequences are duplicated", async () => {
      setupChannels([0, 1, 2].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` })));
      const channels = _.channel.items;
      channels.forEach(channel => channel.setStreams([{ networkId: 32752, streamId: 60001, relTs: 2, format: "tlv", slots: 52, groupId: 9, numberOfCarriers: 3, carrierSequence: 0 }]));
      const ready = mock.fn(async () => channels[0]);
      _.tuner.readyForJob = ready;
      _.tuner.canReceiveTsmfCarriers = () => true;

      assert.strictEqual(channels[0].getBondedChannels().length, 3);
      assert.strictEqual(channels[0].hasAllCarriers(channels[0].streams[0]), false);
      await _.service._readyForScan(channels[0]);
      assert.strictEqual(ready.mock.calls[0].arguments[0], channels[0]);
    });

    // 設定したグループに、ヘッダーのグループ ID がたまたま同じ、自動で判別した別のグループの搬送波を混ぜない
    it("does not mix the carriers discovered into a configured group with the same group ID", () => {
      setupChannels([
        { name: "M1", type: "BS4K", route: "CATV", channel: "C1", tsmfRelTs: 1, tsmfGroupId: 1 },
        { name: "M2", type: "BS4K", route: "CATV", channel: "C2", tsmfRelTs: 1, tsmfGroupId: 1 },
        { name: "A1", type: "BS4K", route: "CATV", channel: "C3" },
        { name: "A2", type: "BS4K", route: "CATV", channel: "C4" }
      ]);
      const [m1, m2, a1, a2] = _.channel.items;
      const stream = i => [{ networkId: 11, streamId: 60009, relTs: 1, format: "tlv", slots: 52, groupId: 1, numberOfCarriers: 2, carrierSequence: i }];
      a1.setStreams(stream(0));
      a2.setStreams(stream(1));
      // the configured carriers have received the same TLV (but they are not discovered)
      m1.setStream(11, 60009, "tlv");
      m2.setStream(11, 60009, "tlv");

      assert.deepStrictEqual(m1.getBondedChannels(), [m1, m2]);
      assert.deepStrictEqual(a1.getBondedChannels(), [a1, a2]);
    });

    // ヘッダーのグループ ID が 0 でも結合する (設定する tsmfGroupId は 1 から 255)
    it("bonds the carriers discovered with the group ID 0", async () => {
      const configs = [0, 1].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` }));
      setupChannels(configs);
      const streams = i => [{ networkId: 11, streamId: 60001, relTs: 1, format: "tlv", slots: 52, groupId: 0, numberOfCarriers: 2, carrierSequence: i }];
      fs.writeFileSync(process.env.CHANNELS_DB_PATH, JSON.stringify([{ __integrity__: "test" }, ...configs.map((c, i) => ({ type: c.type, channel: c.channel, streams: streams(i) }))]));
      await _.channel.load();
      const channels = _.channel.items;

      assert.strictEqual(channels[0].tsmfGroupId, 0);
      assert.deepStrictEqual(channels[0].getBondedChannels(), channels);
      assert.strictEqual(channels[0].hasAllCarriers(channels[0].streams[0]), true);
    });

    it("restores discovery metadata from channels.json without modifying configured values", async () => {
      const configs = [0, 1, 2].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` }));
      setupChannels(configs);
      const streams = i => [{ networkId: 32752, streamId: 60001, relTs: 2, format: "tlv", slots: 52, groupId: 9, numberOfCarriers: 3, carrierSequence: i }];
      fs.writeFileSync(process.env.CHANNELS_DB_PATH, JSON.stringify([{ __integrity__: "test" }, ...configs.map((c, i) => ({ type: c.type, channel: c.channel, streams: streams(i) }))]));
      await _.channel.load();
      for (const [i, channel] of _.channel.items.entries()) {
        assert.deepStrictEqual(channel.streams, streams(i));
        assert.strictEqual(channel.tsmfGroupId, 9);
        assert.strictEqual(channel.getBondedChannels().length, 3);
        assert.strictEqual(channel.toJSON().tsmfRelTs, undefined);
      }
    });
  });

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
      fs.rmSync(process.env.CHANNELS_DB_PATH, { force: true });
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

    // 放送を終了したサービスなど、スキャンしても streamId が付かないサービスで、起動のたびにスキャンしない
    it("does not scan the channels of the services without streamId after a stream is received", async () => {
      setupChannels([
        { name: "GR27", type: "GR", channel: "27" },
        { name: "GR28", type: "GR", channel: "28" }
      ]);
      fs.writeFileSync(process.env.CHANNELS_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { type: "GR", channel: "27", streams: [{ networkId: 32752, streamId: 32752, format: "ts" }] }
      ]));
      fs.writeFileSync(process.env.SERVICES_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { id: 3275201024, serviceId: 1024, networkId: 32752, streamId: 32752, name: "A", type: 1, channel: { type: "GR", channel: "27" } },
        { id: 3275201025, serviceId: 1025, networkId: 32752, name: "ENDED", type: 1, channel: { type: "GR", channel: "27" } },
        { id: 3275301024, serviceId: 1024, networkId: 32753, name: "B", type: 1, channel: { type: "GR", channel: "28" } }
      ]));
      await _.channel.load();
      await _.service.load();

      const jobs = [];
      _.job = { add: job => jobs.push(job), addSchedule: () => {}, jobs: [] };
      await _.service._initJobs();

      assert.deepStrictEqual(jobs.filter(job => job.key.startsWith("Service.Update.Scan.")), []);
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

  describe("API: the stream of a service on a channel", () => {
    // GR27 と GR28 (中継局) が同じストリームを受信できる
    async function setupRelay() {
      setupChannels([
        { name: "GR27", type: "GR", channel: "27" },
        { name: "GR28", type: "GR", channel: "28" }
      ]);
      fs.writeFileSync(process.env.CHANNELS_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { type: "GR", channel: "27", streams: [{ networkId: 32752, streamId: 32752, format: "ts" }] },
        { type: "GR", channel: "28", streams: [{ networkId: 32752, streamId: 32752, format: "ts" }] }
      ]));
      fs.writeFileSync(process.env.SERVICES_DB_PATH, JSON.stringify([
        { __integrity__: "test" },
        { id: 3275201024, serviceId: 1024, networkId: 32752, streamId: 32752, name: "A", type: 1, channel: { type: "GR", channel: "27" } }
      ]));
      await _.channel.load();
      await _.service.load();
    }

    function request(type, channel, id) {
      const req = new EventEmitter();
      Object.assign(req, { method: "GET", params: { type, channel, id }, query: {}, ip: "127.0.0.1", url: "/", socket: { remotePort: 1 }, get: () => undefined });
      const res = {
        socket: { _writableState: {}, setNoDelay: () => {} },
        writableHighWaterMark: 0,
        statusCode: 200,
        setHeader: () => {},
        status(code) { this.statusCode = code; return this; },
        end: () => {}
      };
      return { req, res };
    }

    it("receives the service on the channel requested, not on the other channel carrying the same stream", async () => {
      await setupRelay();
      let formatTargets;
      let streamTargets;
      _.tuner = {
        typeExists: () => true,
        getOutputFormat: targets => (formatTargets = targets, "ts"),
        initServiceStream: (service, userReq, output, targets) => (streamTargets = targets, new Promise(() => {}))
      };
      const { get } = require("../lib/Mirakurun/api/channels/{type}/{channel}/services/{id}/stream");

      const { req, res } = request("GR", "28", 3275201024);
      get(req, res);
      await flush();

      const gr28 = _.channel.get("GR", "28");
      assert.deepStrictEqual(formatTargets.map(target => target.channel), [gr28]);
      assert.deepStrictEqual(streamTargets.map(target => target.channel), [gr28]);

      // /api/services/{id}/stream は、どちらのチャンネルでも受信する
      assert.deepStrictEqual(_.service.get(32752, 1024).targets.map(target => target.channel.channel), ["27", "28"]);
    });
  });

  describe("Tuner: sharing bonded carriers", () => {
    // 判別した相対 TS は、リモートの Mirakurun では受信できない (その Mirakurun の相対 TS を出力する)
    it("does not pick the remote tuners for the carriers of the relative stream detected", () => {
      setupChannels([0, 1].map(i => ({ name: `Carrier ${i}`, type: "BS4K", route: "CATV", channel: `C${i}` })));
      const channels = _.channel.items;
      channels.forEach((channel, i) => channel.setStreams([{ networkId: 11, streamId: 60001, relTs: 1, format: "tlv", slots: 52, groupId: 5, numberOfCarriers: 2, carrierSequence: i }]));
      const local = fakeDevice(0, ["BS4K"], ["CATV"]);
      const remote = fakeDevice(1, ["BS4K"], ["CATV"], { isRemote: true });
      const t = tuner([local, remote]);
      const candidate = t._getCandidate(channels[0], 1);

      assert.strictEqual(t._pickCarrierDevices({ device: local, channel: channels[0], candidate }, 0), null);

      const local2 = fakeDevice(2, ["BS4K"], ["CATV"]);
      t._devices.push(local2);
      assert.deepStrictEqual(t._pickCarrierDevices({ device: local, channel: channels[0], candidate }, 0).map(({ device }) => device), [local2]);
    });

    it("accepts tsmfGroupId without tsmfRelTs for automatic relative-stream discovery", () => {
      const warn = mock.method(log, "warn", () => {});
      try {
        setupChannels([{ name: "TLV", type: "BS4K", channel: "C1", route: "CATV", tsmfGroupId: 5 }]);
        assert.ok(_.channel.get("BS4K", "C1"));
        assert.ok(!warn.mock.calls.some(call => /`tsmfGroupId` without `tsmfRelTs`/.test(call.arguments[0])));
      } finally {
        warn.mock.restore();
      }
    });

    for (const [initialPriority, automatic] of [[-1, false], [0, false], [-1, true]]) {
      it(`keeps all three carriers and the priority ${initialPriority} user when a higher priority stream joins (automatic=${automatic})`, async () => {
        const configs = [1, 2, 3].map(i => ({ name: `Carrier ${i}`, type: "BS4K", channel: `C${i}`, route: "CATV", ...(!automatic && { format: "tlv", tsmfRelTs: 1, tsmfGroupId: 5 }) }));
        setupChannels(configs);
        if (automatic) {
          configs.forEach((c, i) => _.channel.get(c.type, c.channel).setStreams([
            { networkId: 11, streamId: 60001, relTs: 1, format: "tlv", slots: 52, groupId: 5, numberOfCarriers: 3, carrierSequence: i },
            { networkId: 11, streamId: 60002, relTs: 2, format: "tlv", slots: 20, groupId: 5, numberOfCarriers: 3, carrierSequence: i }
          ]));
        }
        _.config.server.disableEITParsing = false;
        const channels = configs.map(c => _.channel.get(c.type, c.channel));
        const devices = configs.map((c, i) => {
          const d = Object.create(TunerDevice.prototype);
          Object.assign(d, { _index: i, _config: { name: `Tuner ${i}`, types: ["BS4K"], routes: ["CATV"] }, _users: new Set(), _isAvailable: true, _channel: null, _stream: null, _dvbActive: false, _isRemote: false, _endStreamTimer: null, _pendingBytes: 0, _flushTimer: null, _spawnedAt: 0 });
          d._updated = () => {};
          d._flushUsersBound = d._flushUsers.bind(d);
          d._spawn = mock.fn(async channel => { d._channel = channel; d._stream = new EventEmitter(); });
          d._kill = mock.fn(async () => { throw new Error("sharing must not retune a carrier"); });
          return d;
        });
        const t = tuner(devices);
        const filters = [];
        const start = async (id, priority, channel, relTs, serviceId) => {
          const filter = await t._initTS({ id, priority, disableDecoder: true, streamSetting: { channel, networkId: 11, serviceId, parseEIT: true } }, undefined, [t._getCandidate(channel, relTs, "tlv")]);
          filters.push(filter);
          return filter;
        };
        try {
          const first = await start("existing", initialPriority, channels[1], 1, undefined);
          assert.deepStrictEqual(devices.map(d => d.users.length), [1, 1, 1]);
          const joined = await start("joined", 2, channels[0], 1, 701);
          const relative = await start("relative", 3, channels[2], 2, 702);
          const firstWrites = mock.method(first, "write");
          const firstCarriers = mock.method(first, "writeCarrier");
          const joinedWrites = mock.method(joined, "write");
          const joinedCarriers = mock.method(joined, "writeCarrier");
          const packet = Buffer.alloc(188, 0xFF); packet[0] = 0x47; packet[1] = 0x1F; packet[2] = 0xFF; packet[3] = 0x10;
          for (const d of devices) { d._streamOnData(packet); d._flushUsers(); }
          assert.deepStrictEqual([firstWrites.mock.callCount(), firstCarriers.mock.callCount(), joinedWrites.mock.callCount(), joinedCarriers.mock.callCount()], [1, 2, 1, 2]);
          assert.strictEqual(first.closed, false);
          assert.deepStrictEqual(devices.map(d => d.users.length), [3, 3, 3]);
          assert.deepStrictEqual(devices.map(d => d.getPriority()), [3, 3, 3]);
          relative.close();
          assert.strictEqual(first.closed, false);
          assert.strictEqual(joined.closed, false);
          assert.deepStrictEqual(devices.map(d => d.users.length), [2, 2, 2]);
          first.close();
          assert.strictEqual(joined.closed, false);
          assert.deepStrictEqual(devices.map(d => d.users.length), [1, 1, 1]);
          assert.deepStrictEqual(devices.map(d => d.getPriority()), [2, 2, 2]);
          for (const d of devices) { d._streamOnData(packet); d._flushUsers(); }
          assert.deepStrictEqual([joinedWrites.mock.callCount(), joinedCarriers.mock.callCount()], [2, 4]);
          assert.ok(devices.every(d => d._spawn.mock.callCount() === 1 && d._kill.mock.callCount() === 0));
        } finally {
          for (const filter of filters) filter.close();
        }
        assert.deepStrictEqual(devices.map(d => d.users.length), [0, 0, 0]);
      });
    }
    it("starts the tuners of all the carriers at once, not to be picked by another request while starting", async () => {
      const configs = [1, 2, 3].map(i => ({ name: `Carrier ${i}`, type: "BS4K", channel: `C${i}`, route: "CATV", format: "tlv", tsmfRelTs: 1, tsmfGroupId: 5 }));
      setupChannels([...configs, { name: "GR27", type: "GR", channel: "27" }]);
      const tuned = [];
      const devices = [0, 1, 2].map(i => {
        const d = Object.create(TunerDevice.prototype);
        Object.assign(d, { _index: i, _config: { name: `Tuner ${i}`, types: ["BS4K", "GR"] }, _users: new Set(), _isAvailable: true, _channel: null, _stream: null, _dvbActive: false, _isRemote: false, _endStreamTimer: null, _pendingBytes: 0, _flushTimer: null, _spawnedAt: 0 });
        d._updated = () => {};
        d._flushUsersBound = d._flushUsers.bind(d);
        // the process starts at once, and the tuning takes time
        d._spawn = channel => {
          d._channel = channel;
          d._stream = new EventEmitter();
          return new Promise(resolve => tuned.push(resolve));
        };
        d._kill = async () => { d._channel = null; d._stream = null; };
        return d;
      });
      const t = tuner(devices);
      const bonded = _.channel.get("BS4K", "C1");
      const gr = _.channel.get("GR", "27");
      const filters = [];
      try {
        const starting = t._initTS({ id: "bonded", priority: 1, disableDecoder: true, streamSetting: { channel: bonded } }, undefined, [t._getCandidate(bonded, 1, "tlv")]);
        await flush();
        // 同じ優先度の別の要求は、搬送波のチューナーを使えない
        t._initTS({ id: "gr", priority: 1, disableDecoder: true, streamSetting: { channel: gr } }, undefined, [t._getCandidate(gr)]).then(filter => filters.push(filter), () => {});
        await flush();
        for (const resolve of tuned) resolve();
        filters.push(await starting);
        assert.deepStrictEqual(devices.map(d => [d.channel.channel, d.users.map(u => u.id)]), [
          ["C1", ["bonded"]], ["C2", ["bonded#carrier1"]], ["C3", ["bonded#carrier2"]]
        ]);
      } finally {
        for (const filter of filters) filter.close();
      }
    });
  });

  describe("Tuner: channel config files of dvbv5", () => {
    it("lists the channels of the channel config files of the tuners used for the scan (the type and the route)", async () => {
      const devices = [
        { index: 0, config: { types: ["GR"], routes: ["SAT"] }, getDvbChannelNames: async () => ["BS01_0"] },
        { index: 1, config: { types: ["GR"], routes: ["CATV"] }, getDvbChannelNames: async () => ["CATV_C21", "CATV_C22"] },
        { index: 2, config: { types: ["GR", "BS"] }, getDvbChannelNames: async () => ["CATV_C22", "CATV_C23"] },
        // the tuner of the other type is not used for the scan
        { index: 3, config: { types: ["BS"] }, getDvbChannelNames: async () => ["BS03_1"] },
        // not dvbv5-zap
        { index: 4, config: { types: ["GR"], routes: ["CATV"] }, getDvbChannelNames: async () => null },
        { index: 5, config: { types: ["GR"], routes: ["CATV"] }, getDvbChannelNames: async () => { throw new Error("ENOENT"); } }
      ];
      const t = tuner(devices);
      assert.deepStrictEqual(await t.getDvbChannelNames("CATV", "GR"), ["CATV_C21", "CATV_C22", "CATV_C23"]);
    });
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
