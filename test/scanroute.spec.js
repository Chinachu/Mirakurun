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
// device: the tuner (or the tuners) of the type to try (by default, the name)
async function runScan(query, scanChannel, { types = ["GR", "BS", "CS", "BS4K"], dvbChannels = [], logs = [], scanTypes, routes, relTsByRemote = [], extraChannels = [], device = type => `tuner of ${type}` } = {}) {
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
      .map(type => ({ type, devices: [].concat(device(type)) })),
    getDvbChannelNames: async () => typeof dvbChannels === "function" ? dvbChannels() : dvbChannels,
    scanChannel: async (channel, user, devices, networkStreams) => {
      assert.deepStrictEqual(devices, [].concat(device(channel.type)));
      tuned.push({ channel: channel.channel, route: channel.route, type: channel.type, ...(networkStreams && { networkStreams }) });
      return scanChannel(channel, networkStreams);
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

  describe("NIT of BS", () => {
    // BS の NIT (2026-11 に受信したもの): 中継器ごとの TSID (BS09_1 と BS23_2 は放送されていない、BS15 は TSID の下位と番号がずれる)
    const bsNit = {
      1: [0x4010, 0x4011, 0x4012],
      3: [0x4030, 0x4631, 0x4632],
      5: [0x4450, 0x4451],
      9: [0x4090, null, 0x4092],
      13: [0x40D0, 0x40D1, 0x46D2],
      15: [0x40F1, 0x40F2, 0x48F3],
      19: [0x4730, 0x4731, 0x4732, 0x4733],
      21: [0x4750, 0x4751, 0x4752],
      23: [0x4770, 0x4971, null, 0x4973]
    };
    const bsName = (transponder, number) => `BS${String(transponder).padStart(2, "0")}_${number}`;
    // the channels broadcast (the name: TSID)
    const broadcast = Object.fromEntries(Object.entries(bsNit).flatMap(([transponder, streamIds]) =>
      streamIds.map((streamId, number) => [bsName(transponder, number), streamId]).filter(([, streamId]) => streamId !== null)));
    const networkStreams = {
      networkId: 4,
      streams: Object.entries(bsNit).flatMap(([transponder, streamIds]) =>
        streamIds.filter(streamId => streamId !== null).map(streamId => ({ streamId, frequency: 11727480 + (transponder - 1) / 2 * 38360 })))
    };
    const names = Object.keys(broadcast).sort();
    // nit: the stream of BS has the streams of the network if collected
    const receive = (nit = true) => (channel, collects) => {
      if (/^CS/.test(channel.channel)) {
        return [{ format: "ts", services: [{ ...service(6, 1, channel.channel), streamId: 0x6000 }] }];
      }
      if (broadcast[channel.channel] === undefined) {
        throw new Error("stream has closed before get network");
      }
      return [{ format: "ts", services: [{ ...service(4, 101, channel.channel), streamId: broadcast[channel.channel] }], ...(collects && nit && { networkStreams }) }];
    };
    const command = types => () => ({ config: { types }, getDvbChannelStream: async () => undefined });
    const tunedBs = tuned => tuned.map(t => t.channel).filter(channel => /^BS/.test(channel));
    const query = { route: "SAT", refresh: true, dryRun: true };

    // 名前から TSID がわからないチューナー: NIT にない中継器と、中継器の TS をすべて受信した後の名前をスキップする
    it("skips the channels of BS not broadcast by the names: the transponders not in NIT, and after all the streams of the transponder are received", async () => {
      const logs = [];
      const device = command(["BS", "CS"])();
      const { tuned } = await runScan(query, receive(), { device: () => device, logs });

      // BS09_1 and BS23_2 are tried (not broadcast, but the streams after them are)
      assert.deepStrictEqual(tunedBs(tuned), [...names, "BS09_1", "BS23_2"].sort());
      // the streams of the network are collected only by the first channel of BS received
      assert.deepStrictEqual(tuned.filter(t => t.networkStreams).map(t => t.channel), ["BS01_0"]);
      assert.strictEqual(tuned.filter(t => /^CS/.test(t.channel)).length, 23);
      assert.strictEqual(logs.filter(text => /not broadcast in TS by NIT of BS, skipped/.test(text)).length, 92 - names.length - 2);
      assert.ok(logs.some(text => /26 streams of BS are known by NIT/.test(text)));
    });

    // TLV 用のチューナー (types に BS4K を含むか、tlvDecoder / tlvToTsDecoder を設定したもの): NIT にない中継器 (TLV) はスキップしない
    it("does not skip the transponders not in NIT on the tuners for TLV", async () => {
      const transponders = [2, 4, 6, 7, 8, 10, 11, 12, 14, 16, 17, 18, 20, 22];
      for (const config of [{ types: ["BS", "CS", "BS4K"] }, { types: ["BS", "CS"], tlvDecoder: "tlv" }, { types: ["BS", "CS"], tlvToTsDecoder: "mmt2ts" }]) {
        const device = { ...command()(), config };
        const { tuned } = await runScan(query, receive(), { device: () => device });

        assert.deepStrictEqual(tunedBs(tuned), [...names, "BS09_1", "BS23_2", ...transponders.flatMap(transponder => [0, 1, 2, 3].map(number => bsName(transponder, number)))].sort());
      }
    });

    // dvbv5 のチャンネル設定 (STREAM_ID が TSID): NIT にない TSID のチャンネルだけをスキップする
    it("skips only the channels of the streams not in NIT by the channel config file of dvbv5", async () => {
      // the streams not broadcast any longer (as dvbconf-for-isdb)
      const conf = { ...broadcast, BS05_2: 0x4452, BS07_0: 0x4470, BS09_1: 0x4091, BS11_0: 0x46B0, BS17_0: 0x4310, BS23_2: 0x4972 };
      const device = {
        config: { types: ["BS", "CS"] },
        getDvbChannelStream: async (route, channel) => conf[channel] === undefined ? null
          : { deliverySystem: 9, frequency: 1049480 + (Number(channel.slice(2, 4)) - 1) / 2 * 38360, streamId: conf[channel] }
      };
      const logs = [];
      const { tuned } = await runScan({ ...query, source: "dvbConf" }, receive(), { device: () => device, dvbChannels: [...Object.keys(conf).sort(), "CS2"], logs });

      assert.deepStrictEqual(tuned.map(t => t.channel), [...names, "CS2"]);
      assert.strictEqual(logs.filter(text => /not broadcast in TS by NIT of BS, skipped/.test(text)).length, 6);
    });

    // NIT を得られなければ、すべてのチャンネルを調べる (最初に受信した BS のチャンネルだけで NIT を待つ)
    it("scans all the channels without NIT of BS", async () => {
      const device = command(["BS", "CS"])();
      const { tuned } = await runScan(query, receive(false), { device: () => device });

      assert.strictEqual(tunedBs(tuned).length, 92);
      assert.deepStrictEqual(tuned.filter(t => t.networkStreams).map(t => t.channel), ["BS01_0"]);
    });

    // 指定されたチャンネル (list / format / 4.3.0 の type) と、ほかの受信経路はスキップしない
    it("does not skip the channels specified, and of the other routes", async () => {
      const device = command(["GR", "BS", "CS"])();
      for (const specified of [
        { route: "SAT", source: "list", channels: ["BS01_0", "BS01_3", "BS07_0"] },
        { route: "SAT", source: "format", channelNameFormat: "BS{ch00}_{subch}", minCh: 1, maxCh: 1 },
        { type: "BS", minCh: 1, maxCh: 1 },
        { route: "CATV", source: "dvbConf" }
      ]) {
        const { tuned } = await runScan({ ...specified, refresh: true, dryRun: true }, receive(), { device: () => device, dvbChannels: ["BS01_0", "BS01_3", "BS07_0"] });
        assert.ok(tuned.some(t => t.channel === "BS01_3"), JSON.stringify(specified));
        assert.strictEqual(tuned.some(t => t.networkStreams), false);
      }
    });

    // FTTH の地上波のチューナーのチャンネル設定に BS のチャンネルはないため、衛星のチューナーで試さないチャンネルはスキップとして出す
    it("shows the channel as skipped if the other tuners do not have it in the channel config files of dvbv5", async () => {
      const conf = { BS09_0: 0x4090, BS09_1: 0x4091, BS09_2: 0x4092 };
      const devices = {
        GR: { config: { types: ["GR"] }, getDvbChannelStream: async () => null },
        BS: {
          config: { types: ["BS", "CS"] },
          getDvbChannelStream: async (route, channel) => conf[channel] === undefined ? null : { deliverySystem: 9, frequency: 1202920, streamId: conf[channel] }
        }
      };
      const logs = [];
      const { tuned } = await runScan(
        { route: "FTTH", source: "dvbConf", refresh: true, dryRun: true },
        (channel, collects) => {
          if (channel.type === "GR") {
            throw new Error(`channel ${channel.channel} is not found in isdbt.conf`);
          }
          return receive()(channel, collects);
        },
        { device: type => devices[type], scanTypes: ["GR", "BS"], dvbChannels: Object.keys(conf), logs }
      );

      assert.deepStrictEqual(tuned.map(t => [t.channel, t.type]), [["BS09_0", "BS"], ["BS09_1", "GR"], ["BS09_2", "BS"]]);
      assert.strictEqual(logs.filter(text => /not broadcast in TS by NIT of BS, skipped/.test(text)).length, 1);
      assert.strictEqual(logs.some(text => /no signal/.test(text)), false);
    });

    // BS の TS を運ぶほかのチャンネル (ケーブルテレビなど) で受信した TS は、中継器の TS を受信済みと数えない
    it("does not count the streams of BS received by the channels not of BS", async () => {
      // the channels of the cable television carrying the streams of BS, before and after NIT of BS is known
      const cable = { C38: 0x4030, C39: 0x4631, C40: 0x4011, C41: 0x4012, C42: 0x4632 };
      const channels = ["C38", "C39", "BS01_0", "C40", "C41", "BS01_1", "BS01_2", "BS01_3", "C42", "BS03_0", "BS03_1", "BS03_2", "BS03_3"];
      const device = command(["GR", "BS", "CS"])();
      const { tuned } = await runScan(
        { route: "FTTH", source: "dvbConf", refresh: true, dryRun: true },
        (channel, collects) => cable[channel.channel] === undefined ? receive()(channel, collects)
          : [{ format: "ts", services: [{ ...service(4, 101, channel.channel), streamId: cable[channel.channel] }] }],
        { device: () => device, scanTypes: ["BS"], dvbChannels: channels }
      );

      // only BS01_3 and BS03_3 are skipped, after all the streams of the transponder are received by the channels of BS
      assert.deepStrictEqual(tuned.map(t => t.channel), channels.filter(channel => !/^BS0[13]_3$/.test(channel)));
      assert.deepStrictEqual(tuned.filter(t => t.networkStreams).map(t => t.channel), ["BS01_0"]);
    });

    // 同じタイプのチューナーが複数ある場合は、どれか 1 つでも放送されていないと判別できなければ試す
    it("tries the channel unless not broadcast on all the tuners of the same types", async () => {
      const conf = { BS05_0: 0x4450, BS05_1: 0x4451, BS05_2: 0x4452, BS09_0: 0x4090, BS09_1: 0x4091, BS09_2: 0x4092 };
      const devices = [
        {
          config: { types: ["BS", "CS"] },
          getDvbChannelStream: async (route, channel) => ({ deliverySystem: 9, frequency: channel.startsWith("BS05") ? 1126200 : 1202920, streamId: conf[channel] })
        },
        command(["BS", "CS"])()
      ];
      const { tuned } = await runScan({ ...query, source: "dvbConf" }, receive(), { device: () => devices, dvbChannels: Object.keys(conf) });

      // BS05_2: not in NIT by the channel config file, and all the streams of BS-5 are received (by the name)
      // BS09_1: not in NIT by the channel config file, but the streams of BS-9 are not all received yet (by the name)
      assert.deepStrictEqual(tuned.map(t => t.channel), ["BS05_0", "BS05_1", "BS09_0", "BS09_1", "BS09_2"]);
    });

    // スキップしても、スキップしない場合 (list で同じチャンネルを指定) と同じ結果になる (4.3.0 の channels.yml からの更新)
    it("saves the same channels as without skipping", async () => {
      const extraChannels = [
        { name: "NHK BS", type: "BS", channel: "BS15_0", serviceId: 101 },
        { name: "BS12", type: "BS", channel: "BS09_2", serviceId: 222, isDisabled: true },
        { name: "closed", type: "BS", channel: "BS23_2", serviceId: 999, isDisabled: true },
        { name: "closed 2", type: "BS", channel: "BS07_0", serviceId: 998 },
        { name: "shop", type: "CS", channel: "CS8", serviceId: 55 }
      ];
      const conf = { ...broadcast, BS05_2: 0x4452, BS07_0: 0x4470, BS09_1: 0x4091, BS11_0: 0x46B0, BS17_0: 0x4310, BS23_2: 0x4972 };
      const dvb = {
        config: { types: ["BS", "CS"] },
        getDvbChannelStream: async (route, channel) => conf[channel] === undefined ? null
          : { deliverySystem: 9, frequency: 1049480 + (Number(channel.slice(2, 4)) - 1) / 2 * 38360, streamId: conf[channel] }
      };
      for (const [source, device, channels] of [
        ["preset", command(["BS", "CS"])(), scan.getPresetChannels("SAT")],
        ["dvbConf", dvb, [...Object.keys(conf).sort(), "CS2", "CS8"]]
      ]) {
        for (const refresh of [true, false]) {
          const options = { device: () => device, dvbChannels: channels, extraChannels };
          const skipped = await runScan({ route: "SAT", source, ...(refresh && { refresh }) }, receive(), options);
          const all = await runScan({ route: "SAT", source: "list", channels, ...(refresh && { refresh }) }, receive(), options);

          assert.ok(skipped.tuned.length < all.tuned.length, `${source} ${refresh}`);
          assert.deepStrictEqual(skipped.saved, all.saved, `${source} ${refresh}`);
          // the entry enabled is taken over without `refresh`, the entries of the channels not broadcast are removed
          assert.strictEqual(skipped.saved.some(item => item.name === "NHK BS"), !refresh);
          assert.strictEqual(skipped.saved.some(item => item.name === "closed"), false);
          assert.strictEqual(skipped.saved.some(item => item.name === "closed 2"), !refresh);
        }
      }
    });

    // 既存の設定を引き継いだチャンネルの TS は受信していないため、その中継器の残りの名前はスキップしない
    it("does not skip the rest of the transponder with the channel taken over", async () => {
      const device = command(["BS", "CS"])();
      const { tuned } = await runScan({ route: "SAT", dryRun: true }, receive(), { device: () => device });

      // BS01_0 is taken over (the streams of the network are collected by BS01_1)
      assert.deepStrictEqual(tunedBs(tuned).slice(0, 4), ["BS01_1", "BS01_2", "BS01_3", "BS03_0"]);
      assert.deepStrictEqual(tuned.filter(t => t.networkStreams).map(t => t.channel), ["BS01_1"]);
      assert.strictEqual(tunedBs(tuned).includes("BS03_3"), false);
    });
  });

  it("rejects the route without the tuners, and the channel config files without the channels", async () => {
    let result = await runScan({ route: "SAT" }, () => [], { types: [] });
    assert.deepStrictEqual(result.errors.map(e => e.code), [400]);
    assert.deepStrictEqual(result.tuned, []);

    result = await runScan({ route: "CATV", source: "dvbConf" }, () => []);
    assert.deepStrictEqual(result.errors.map(e => e.code), [400]);
  });
});
