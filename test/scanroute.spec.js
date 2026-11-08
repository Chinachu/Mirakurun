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
async function runScan(query, scanChannel, { types = ["GR", "BS", "CS", "BS4K"], dvbChannels = [], logs = [], scanTypes, routes, relTsByRemote = [], extraChannels = [] } = {}) {
  const saved = [];
  const tuned = [];
  const errors = [];
  config.loadChannels = async () => [...oldChannels, ...extraChannels].map(item => ({ ...item }));
  config.saveChannels = async items => {
    saved.push(items);
  };
  _.tuner = {
    typeExists: (type, route) => types.includes(type) && (!routes || routes.includes(route)),
    receivesRelTsByRemote: async (type, route, channel) => relTsByRemote.includes(`${type}/${route}/${channel}`),
    getScanAttempts: (route, order) => (scanTypes ? order.filter(type => scanTypes.includes(type)) : order.filter(type => types.includes(type)).slice(0, 1))
      .map(type => ({ type, devices: [`tuner of ${type}`] })),
    getDvbChannelNames: async () => typeof dvbChannels === "function" ? dvbChannels() : dvbChannels,
    scanChannel: async (channel, user, devices) => {
      assert.deepStrictEqual(devices, [`tuner of ${channel.type}`]);
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
      { name: "CATV14", type: "GR", channel: "C14", route: "CATV" },
      { name: "BS01", type: "BS", channel: "BS01_0" },
      { name: "CATVBS", type: "BS", channel: "C14", route: "CATV", serviceId: 101 },
      { name: "BS 1", type: "BS", channel: "C21", serviceId: 101, isDisabled: true, route: "CATV", tsmfRelTs: 1 },
      { name: "CS 1", type: "CS", channel: "C21", serviceId: 201, isDisabled: true, route: "CATV", tsmfRelTs: 2 },
      { name: "ケーブル", type: "CATV", channel: "C13", serviceId: 1, isDisabled: true }
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
    const { tuned } = await runScan({ route: "FTTH", source: "list", channels: ["13", "BS01_3", "CS13"], skipCh: ["13"], refresh: true, dryRun: true }, () => []);
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

  // 無効な設定は読み込まないため、ほかの経路の無効な設定があっても追加する
  it("adds the channel of the type and the name configured on another route but disabled", async () => {
    oldChannels.push({ name: "TER28", type: "GR", channel: "28", isDisabled: true });
    try {
      const { saved } = await runScan(
        { route: "CATV", source: "list", channels: ["28"], refresh: true },
        () => [{ format: "ts", services: [service(0x7FE0, 28, "地上 28")] }]
      );
      assert.deepStrictEqual(saved.filter(item => item.channel === "28").map(item => [item.name, item.route, item.isDisabled]), [
        ["TER28", undefined, true],
        ["地上 28", "CATV", false]
      ]);
    } finally {
      oldChannels.pop();
    }
  });

  // 受信経路が正しくない設定は読み込まないため、ほかの経路の設定があっても追加する
  it("adds the channel of the type and the name configured with an invalid route", async () => {
    oldChannels.push({ name: "ter28", type: "GR", channel: "28", route: "ter" });
    try {
      const { saved } = await runScan(
        { route: "CATV", source: "list", channels: ["28"], refresh: true },
        () => [{ format: "ts", services: [service(0x7FE0, 28, "地上 28")] }]
      );
      assert.deepStrictEqual(saved.filter(item => item.channel === "28").map(item => [item.name, item.route]), [
        ["ter28", "ter"],
        ["地上 28", "CATV"]
      ]);
    } finally {
      oldChannels.pop();
    }
  });

  // 受信経路にそのタイプのチューナーがない設定は読み込まないため、ほかの経路の設定があっても追加する
  it("adds the channel of the type and the name configured on another route without the tuners of the type", async () => {
    const logs = [];
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["13"], refresh: true },
      () => [{ format: "ts", services: [service(0x7FE0, 13, "地上 13")] }],
      { logs, routes: ["CATV"] }
    );
    assert.deepStrictEqual(saved.filter(item => item.channel === "13").map(item => [item.name, item.route]), [
      ["TER13", undefined],
      ["地上 13", "CATV"]
    ]);
    assert.ok(!logs.some(text => /already configured/.test(text)));
  });

  // リモートのチューナーだけで受信し、リモートの Mirakurun が相対 TS を出力するタイプには tsmfRelTs を書かない
  it("does not write tsmfRelTs for the type received only by the remote tuners outputting the relative streams", async () => {
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["C30"], refresh: true },
      () => [
        { relTs: 1, format: "ts", networkId: 0xFFFE, services: [service(0xFFFE, 1, "ケーブル")] },
        { relTs: 2, format: "ts", networkId: 4, services: [service(4, 101, "BS")] }
      ],
      { relTsByRemote: ["BS/CATV/C30"] }
    );
    assert.deepStrictEqual(saved.filter(item => item.channel === "C30").map(item => [item.type, item.tsmfRelTs]), [["BS", undefined], ["CATV", 1]]);
  });

  // 4.3.0 との互換: type を指定すると、そのタイプのチューナーで、そのタイプの既定の受信経路の 4.3.0 と同じチャンネルをスキャンする
  it("scans the channels of the type of 4.3.0 by the tuners of the type", async () => {
    const { saved, tuned, errors } = await runScan(
      { type: "BS", minCh: 1, maxCh: 3, minSubCh: 0, maxSubCh: 1, skipCh: ["20"], refresh: true },
      channel => [{ format: "ts", services: [service(4, 101, channel.channel)] }],
      { scanTypes: ["GR", "BS", "CS"] }
    );

    assert.deepStrictEqual(errors, []);
    // skipCh: the numbers in the names of 4.3.0 (BS02_0 -> 20)
    assert.deepStrictEqual(tuned.map(t => [t.channel, t.route, t.type]), [
      ["BS01_0", "SAT", "BS"], ["BS01_1", "SAT", "BS"], ["BS02_1", "SAT", "BS"], ["BS03_0", "SAT", "BS"], ["BS03_1", "SAT", "BS"]
    ]);
    // BS and CS are added in disabled state by default (as 4.3.0)
    const added = saved.filter(item => item.channel === "BS01_1");
    assert.deepStrictEqual(added.map(item => [item.type, item.route, item.isDisabled]), [["BS", undefined, true]]);

    // GR: 13-62 by the tuners of GR, CS: CS2-CS24
    const gr = await runScan({ type: "GR", dryRun: true, refresh: true }, () => [], { scanTypes: ["GR", "BS"] });
    assert.deepStrictEqual(gr.tuned.map(t => t.channel), Array.from({ length: 50 }, (_, i) => `${i + 13}`));
    assert.ok(gr.tuned.every(t => t.type === "GR" && t.route === "TER"));
    const cs = await runScan({ type: "CS", minCh: 2, maxCh: 4, dryRun: true }, () => [], { scanTypes: ["BS", "CS"] });
    assert.deepStrictEqual(cs.tuned.map(t => [t.channel, t.type]), [["CS2", "CS"], ["CS3", "CS"], ["CS4", "CS"]]);
  });

  it("replaces only the entries of the type of 4.3.0", async () => {
    const old = config.loadChannels;
    const { saved } = await runScan(
      { type: "BS", minCh: 1, maxCh: 1, maxSubCh: 0, refresh: true },
      // BS and a stream of the network of SKY (not of the type) on the channel
      () => [{ format: "ts", relTs: 1, services: [service(4, 101, "BS")] }, { format: "ts", relTs: 2, services: [service(1, 102, "SKY")] }],
      { scanTypes: ["BS"], extraChannels: [
        { name: "BS4K", type: "BS4K", channel: "BS01_0", tsmfRelTs: 2 },
        { name: "SKY", type: "SKY", channel: "BS01_0" }
      ] }
    );
    config.loadChannels = old;

    assert.deepStrictEqual(saved.filter(item => item.channel === "BS01_0").map(item => [item.type, item.name]).sort(),
      [["BS", "BS"], ["BS4K", "BS4K"], ["SKY", "SKY"]]);
  });

  it("takes over only the entries of the type of 4.3.0", async () => {
    const { saved, tuned } = await runScan(
      { type: "BS", minCh: 1, maxCh: 2, maxSubCh: 0 },
      channel => [{ format: "ts", services: [service(4, 101, channel.channel)] }],
      { scanTypes: ["BS"], extraChannels: [{ name: "SKY1", type: "SKY", channel: "BS01_0" }] }
    );

    // BS01_0 has the enabled entry of BS (taken over), the entry of SKY remains once
    assert.deepStrictEqual(tuned.map(t => t.channel), ["BS02_0"]);
    assert.deepStrictEqual(saved.filter(item => item.channel === "BS01_0").map(item => [item.type, item.name]).sort(),
      [["BS", "BS01"], ["SKY", "SKY1"]]);
  });

  it("rejects the type of 4.3.0 with the route or the source, and the other types", async () => {
    // listed in the API document (the client of 4.3.0 sends only the parameters listed)
    assert.ok(scan.put.apiDoc.parameters.some(parameter => parameter.name === "type"));
    for (const query of [{ type: "BS", route: "CATV" }, { type: "GR", source: "list", channels: ["13"] }, { type: "SKY" }]) {
      const result = await runScan(query, () => []);
      assert.deepStrictEqual(result.errors.map(e => e.code), [400], JSON.stringify(query));
      assert.deepStrictEqual(result.tuned, []);
    }
  });

  // 準備中に中止を要求されて開始しなかった場合も、中止の要求を次のスキャンに残さない
  it("does not keep the cancellation requested while preparing a scan not started", async () => {
    const getStatus = async () => {
      return new Promise(resolve => scan.get({}, { setHeader() {}, status() {}, end(body) { resolve(JSON.parse(body)); } }));
    };
    await runScan({ route: "TER", source: "list", channels: ["27"], refresh: true, dryRun: true }, () => []);
    const previous = await getStatus();
    assert.strictEqual(previous.status, "completed");

    let result = await runScan({ route: "CATV", source: "dvbConf" }, () => [], {
      dvbChannels: () => {
        scan.del({}, { status() {}, setHeader() {}, json() {} });
        return [];
      }
    });
    assert.deepStrictEqual(result.errors.map(e => e.code), [400]);
    // the status of the previous scan is kept
    assert.deepStrictEqual(await getStatus(), previous);

    result = await runScan({ route: "CATV", source: "list", channels: ["C13"], refresh: true }, () => [{ format: "ts", services: [service(0xFFFE, 1, "ケーブル")] }]);
    assert.deepStrictEqual(result.tuned.map(t => t.channel), ["C13"]);
    assert.ok(result.saved.some(item => item.name === "ケーブル"));
  });

  // ISDB-T と ISDB-S のチューナーが別の場合は、受信できるまでそれぞれのタイプのチューナーで試す
  it("tries the tuners of each type until received", async () => {
    const { saved, tuned } = await runScan(
      { route: "FTTH", source: "list", channels: ["27", "BS03_1", "C13"], refresh: true },
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
    assert.deepStrictEqual(saved.filter(item => item.route === "FTTH").map(item => [item.type, item.channel]), [["GR", "27"], ["BS", "BS03_1"], ["BS", "C13"]]);
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
      { route: "FTTH", source: "list", channels: ["27"], refresh: true, dryRun: true },
      channel => { throw new Error(channel.type === "GR" ? "spawn recpt1 ENOENT" : "stream has closed before get network"); },
      { scanTypes: ["GR", "BS"], logs }
    );
    assert.deepStrictEqual(result.tuned.map(t => t.type), ["GR", "BS"]);
    assert.ok(logs.some(text => /spawn recpt1 ENOENT/.test(text)));

    // no signal over the channel not in the channel config of dvbv5 of the tuners of the other type
    logs.length = 0;
    result = await runScan(
      { route: "FTTH", source: "list", channels: ["27"], refresh: true, dryRun: true },
      channel => { throw new Error(channel.type === "GR" ? "stream has closed before get network" : "channel 27 is not found in /etc/isdbs.conf"); },
      { scanTypes: ["GR", "BS"], logs }
    );
    assert.deepStrictEqual(result.tuned.map(t => t.type), ["GR", "BS"]);
    assert.ok(logs.some(text => /^-> no signal\.\n/.test(text)));
    assert.ok(!logs.some(text => /is not found/.test(text)));

    result = await runScan(
      { route: "FTTH", source: "list", channels: ["27", "28"], refresh: true },
      () => {
        scan.del({}, { status() {}, setHeader() {}, json() {} });
        throw new Error("stream has closed before get network");
      },
      { scanTypes: ["GR", "BS"] }
    );
    assert.deepStrictEqual(result.tuned.map(t => [t.channel, t.type]), [["27", "GR"]]);
    assert.strictEqual(result.saved, undefined);
  });

  // 準備でのエラー (大きすぎる範囲など) では開始せず、次のスキャンを妨げない
  it("rejects the scan failing to prepare, and the next scan runs", async () => {
    let result = await runScan({ route: "CATV", source: "format", channelNameFormat: "C{ch}", minCh: 0, maxCh: 4294967296 }, () => []);
    assert.deepStrictEqual(result.errors.map(e => e.code), [400]);

    result = await runScan({ route: "CATV", source: "list", channels: ["C13"], refresh: true, dryRun: true }, () => []);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.tuned.map(t => t.channel), ["C13"]);
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
