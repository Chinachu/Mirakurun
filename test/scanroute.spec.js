const { describe, it, before, after } = require("node:test");
const assert = require("assert");

const config = require("../lib/Mirakurun/config");
const _ = require("../lib/Mirakurun/_").default;
const scan = require("../lib/Mirakurun/api/config/channels/scan");

const oldChannels = [
  { name: "TER13", type: "GR", channel: "13" },
  { name: "CATV13", type: "GR", channel: "C13", route: "CATV" },
  { name: "CATV14", type: "GR", channel: "C14", route: "CATV" },
  { name: "CATVBS", type: "BS", channel: "C14", route: "CATV", serviceId: 101 },
  { name: "BS01", type: "BS", channel: "BS01_0" }
];

const service = (networkId, serviceId, name) => ({ networkId, serviceId, name, type: 1, streamId: 1 });

// scanTypes: the types to try (by default, a tuner of all the types)
async function runScan(query, scanChannel, { types = ["GR", "BS", "CS", "BS4K"], dvbChannels = [], logs = [], scanTypes } = {}) {
  const saved = [];
  const tuned = [];
  const errors = [];
  config.loadChannels = async () => oldChannels.map(item => ({ ...item }));
  config.saveChannels = async items => {
    saved.push(items);
  };
  _.tuner = {
    typeExists: type => types.includes(type),
    getScanTypes: (route, order) => scanTypes ? order.filter(type => scanTypes.includes(type)) : order.filter(type => types.includes(type)).slice(0, 1),
    getDvbChannelNames: async () => typeof dvbChannels === "function" ? dvbChannels() : dvbChannels,
    scanChannel: async channel => {
      tuned.push({ channel: channel.channel, route: channel.route, type: channel.type });
      return scanChannel(channel);
    }
  };
  const req = { query, setTimeout() {} };
  const res = { setHeader() {}, status() {}, write(text) { logs.push(text); }, end() {} };
  api.responseError = (_res, code, reason) => errors.push({ code, reason });
  await scan.put(req, res);
  return { saved: saved[0], tuned, errors };
}

const api = require("../lib/Mirakurun/api");

describe("[scanroute.spec] /api/config/channels/scan : route", () => {
  let backup;
  before(() => {
    backup = { loadChannels: config.loadChannels, saveChannels: config.saveChannels, tuner: _.tuner, responseError: api.responseError };
  });
  after(() => {
    config.loadChannels = backup.loadChannels;
    config.saveChannels = backup.saveChannels;
    _.tuner = backup.tuner;
    api.responseError = backup.responseError;
  });

  it("scans the channels of the route and adds the entries of the type of each stream", async () => {
    const { saved, tuned } = await runScan(
      { route: "CATV", source: "list", channels: ["C13", "C21"], refresh: true },
      channel => channel.channel === "C13"
        ? [{ format: "ts", services: [service(0xFFFE, 1, "ケーブル")] }]
        : [
          { relTs: 1, format: "ts", services: [service(4, 101, "BS 1")] },
          { relTs: 2, format: "ts", services: [service(6, 201, "CS 1")] }
        ]
    );

    // the tuners of the route (any type) tune the channels
    assert.deepStrictEqual(tuned, [{ channel: "C13", route: "CATV", type: "GR" }, { channel: "C21", route: "CATV", type: "GR" }]);
    assert.deepStrictEqual(saved, [
      { name: "TER13", type: "GR", channel: "13" },
      { name: "ケーブル", type: "GR", channel: "C13", isDisabled: false, route: "CATV" },
      { name: "CATV14", type: "GR", channel: "C14", route: "CATV" },
      { name: "BS01", type: "BS", channel: "BS01_0" },
      { name: "CATVBS", type: "BS", channel: "C14", route: "CATV", serviceId: 101 },
      { name: "BS 1", type: "BS", channel: "C21", serviceId: 101, isDisabled: true, route: "CATV", tsmfRelTs: 1 },
      { name: "CS 1", type: "CS", channel: "C21", serviceId: 201, isDisabled: true, route: "CATV", tsmfRelTs: 2 }
    ]);
  });

  it("takes over all the entries of the channel on the route if an entry is enabled", async () => {
    const { saved, tuned } = await runScan(
      { route: "CATV", source: "list", channels: ["C14"] },
      () => [{ format: "ts", services: [service(0xFFFE, 1, "ケーブル14")] }]
    );

    // C14 は CATV の既存の設定 (GR と BS) を引き継ぎ、スキャンしない
    assert.deepStrictEqual(tuned, []);
    assert.deepStrictEqual(saved.map(item => item.name), ["TER13", "CATV13", "CATV14", "BS01", "CATVBS"]);
  });

  it("scans the channels of the channel config files of dvbv5, skipping the channels by the names", async () => {
    const { tuned } = await runScan(
      { route: "CATV", source: "dvbConf", skipCh: ["CATV_C22", "CATV_C23"], refresh: true, dryRun: true },
      () => [],
      { dvbChannels: ["CATV_C21", "CATV_C22", "CATV_C23", "CATV_C24"] }
    );

    assert.deepStrictEqual(tuned.map(t => t.channel), ["CATV_C21", "CATV_C24"]);
  });

  // 数値は、その名前のチャンネルだけをスキップする (BS01_3 や CS13 はスキップしない)
  it("skips only the channels of the names", async () => {
    const { tuned } = await runScan({ route: "HIKARI", source: "list", channels: ["13", "BS01_3", "CS13"], skipCh: ["13"], refresh: true, dryRun: true }, () => []);
    assert.deepStrictEqual(tuned.map(t => t.channel), ["BS01_3", "CS13"]);
  });

  // チャンネルはタイプとチャンネル名で区別するため、ほかの経路と同じタイプとチャンネル名のチャンネルは追加しない
  it("does not add the channel of the type and the name configured on another route", async () => {
    const logs = [];
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["13", "27"], refresh: true },
      channel => [{ format: "ts", services: [service(0x7FE0, Number(channel.channel), `地上 ${channel.channel}`)] }],
      { logs }
    );

    assert.deepStrictEqual(saved.filter(item => item.channel === "13" || item.channel === "27"), [
      { name: "TER13", type: "GR", channel: "13" },
      { name: "地上 27", type: "GR", channel: "27", isDisabled: false, route: "CATV" }
    ]);
    assert.ok(logs.some(text => /GR "13" is already configured on the route TER, not added/.test(text)));
  });

  // 互換性のない変更: タイプではなく受信経路でスキャンする
  it("rejects the type, which is no longer supported", async () => {
    const result = await runScan({ type: "BS" }, () => []);
    assert.deepStrictEqual(result.errors.map(e => e.code), [400]);
    assert.deepStrictEqual(result.tuned, []);
    assert.strictEqual(result.saved, undefined);
  });

  // 準備中に中止を要求されて開始しなかった場合も、中止の要求を次のスキャンに残さない
  it("does not keep the cancellation requested while preparing a scan not started", async () => {
    let result = await runScan({ route: "CATV", source: "dvbConf" }, () => [], {
      dvbChannels: () => {
        scan.del({}, { status() {}, setHeader() {}, json() {} });
        return [];
      }
    });
    assert.deepStrictEqual(result.errors.map(e => e.code), [400]);

    result = await runScan({ route: "CATV", source: "list", channels: ["C13"], refresh: true }, () => [{ format: "ts", services: [service(0xFFFE, 1, "ケーブル")] }]);
    assert.deepStrictEqual(result.tuned.map(t => t.channel), ["C13"]);
    assert.ok(result.saved.some(item => item.name === "ケーブル"));
  });

  // ISDB-T と ISDB-S のチューナーが別の場合は、受信できるまでそれぞれのタイプのチューナーで試す
  it("tries the tuners of each type until received", async () => {
    const { saved, tuned } = await runScan(
      { route: "HIKARI", source: "list", channels: ["27", "BS03_1", "C13"], refresh: true },
      channel => {
        if ((channel.type === "GR") !== /^\d+$/.test(channel.channel)) {
          throw new Error("stream has closed before get network");
        }
        return [{ format: "ts", services: [service(channel.type === "GR" ? 0x7FE0 : 4, 101, channel.channel)] }];
      },
      { scanTypes: ["GR", "BS"] }
    );

    // the satellite types first for the channels named BS / CS, the other types if not received (C13 is received only by the tuner of BS)
    assert.deepStrictEqual(tuned.map(t => [t.channel, t.type]), [["27", "GR"], ["BS03_1", "BS"], ["C13", "GR"], ["C13", "BS"]]);
    assert.deepStrictEqual(saved.filter(item => item.route === "HIKARI").map(item => [item.type, item.channel]), [["GR", "27"], ["BS", "BS03_1"], ["BS", "C13"]]);
  });

  // 受信経路の放送のタイプだけを試す (routes のないチューナーは、すべての受信経路のチューナー)
  it("tries only the types of the route", async () => {
    const { tuned } = await runScan(
      { route: "TER", source: "list", channels: ["13"], refresh: true, dryRun: true },
      () => { throw new Error("stream has closed before get network"); },
      { scanTypes: ["GR", "BS", "SKY"] }
    );
    assert.deepStrictEqual(tuned.map(t => t.type), ["GR"]);
  });

  it("shows the error other than no signal, and stops trying the types when cancelled", async () => {
    const logs = [];
    let result = await runScan(
      { route: "HIKARI", source: "list", channels: ["27"], refresh: true, dryRun: true },
      channel => { throw new Error(channel.type === "GR" ? "spawn recpt1 ENOENT" : "stream has closed before get network"); },
      { scanTypes: ["GR", "BS"], logs }
    );
    assert.deepStrictEqual(result.tuned.map(t => t.type), ["GR", "BS"]);
    assert.ok(logs.some(text => /spawn recpt1 ENOENT/.test(text)));

    result = await runScan(
      { route: "HIKARI", source: "list", channels: ["27", "28"], refresh: true },
      () => {
        scan.del({}, { status() {}, setHeader() {}, json() {} });
        throw new Error("stream has closed before get network");
      },
      { scanTypes: ["GR", "BS"] }
    );
    assert.deepStrictEqual(result.tuned.map(t => [t.channel, t.type]), [["27", "GR"]]);
    assert.strictEqual(result.saved, undefined);
  });

  it("uses the tuners of any type of the route", async () => {
    const { tuned } = await runScan({ route: "SAT", source: "list", channels: ["CS2"], refresh: true, dryRun: true }, () => [], { types: ["CS"] });
    assert.deepStrictEqual(tuned, [{ channel: "CS2", route: "SAT", type: "CS" }]);
  });

  it("rejects the route without the tuners, and the channel config files without the channels", async () => {
    let result = await runScan({ route: "SAT" }, () => [], { types: [] });
    assert.deepStrictEqual(result.errors.map(e => e.code), [400]);
    assert.deepStrictEqual(result.tuned, []);

    result = await runScan({ route: "CATV", source: "dvbConf" }, () => []);
    assert.deepStrictEqual(result.errors.map(e => e.code), [400]);
  });
});
