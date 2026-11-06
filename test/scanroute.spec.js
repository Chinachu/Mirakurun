const { describe, it, before, after } = require("node:test");
const assert = require("assert");

const config = require("../lib/Mirakurun/config");
const _ = require("../lib/Mirakurun/_").default;
const scan = require("../lib/Mirakurun/api/config/channels/scan");

const oldChannels = [
  { name: "TER13", type: "GR", channel: "13" },
  { name: "CATV13", type: "GR", channel: "C13", route: "CATV" },
  { name: "CATV14", type: "GR", channel: "C14", route: "CATV" },
  { name: "BS01", type: "BS", channel: "BS01_0" }
];

async function runScan(query, getServices) {
  const saved = [];
  const tuned = [];
  config.loadChannels = async () => oldChannels.map(item => ({ ...item }));
  config.saveChannels = async items => {
    saved.push(items);
  };
  _.tuner = {
    getServices: async channel => {
      tuned.push({ channel: channel.channel, route: channel.route });
      return getServices(channel);
    }
  };
  const req = { query, setTimeout() {} };
  const res = { setHeader() {}, status() {}, write() {}, end() {} };
  await scan.put(req, res);
  return { saved: saved[0], tuned };
}

describe("[scanroute.spec] /api/config/channels/scan : route", () => {
  let backup;
  before(() => {
    backup = { loadChannels: config.loadChannels, saveChannels: config.saveChannels, tuner: _.tuner };
  });
  after(() => {
    config.loadChannels = backup.loadChannels;
    config.saveChannels = backup.saveChannels;
    _.tuner = backup.tuner;
  });

  it("replaces only the entries of the route scanned, and adds the route to the new ones", async () => {
    const { saved, tuned } = await runScan(
      { type: "GR", route: "CATV", minCh: 13, maxCh: 13, channelNameFormat: "C{ch}", refresh: true },
      () => [{ name: "ケーブル", serviceId: 1, type: 1 }]
    );

    assert.deepStrictEqual(tuned, [{ channel: "C13", route: "CATV" }]);
    assert.deepStrictEqual(saved, [
      { name: "TER13", type: "GR", channel: "13" },
      { name: "ケーブル", type: "GR", channel: "C13", isDisabled: false, route: "CATV" },
      { name: "BS01", type: "BS", channel: "BS01_0" }
    ]);
  });

  it("uses the default route of the type if not specified, as before", async () => {
    const { saved, tuned } = await runScan(
      { type: "GR", minCh: 13, maxCh: 13, refresh: true },
      () => [{ name: "地上", serviceId: 1, type: 1 }]
    );

    assert.deepStrictEqual(tuned, [{ channel: "13", route: "TER" }]);
    assert.deepStrictEqual(saved, [
      { name: "地上", type: "GR", channel: "13", isDisabled: false },
      { name: "CATV13", type: "GR", channel: "C13", route: "CATV" },
      { name: "CATV14", type: "GR", channel: "C14", route: "CATV" },
      { name: "BS01", type: "BS", channel: "BS01_0" }
    ]);
  });

  it("takes over the existing entry only of the same route", async () => {
    const { saved, tuned } = await runScan(
      { type: "GR", route: "CATV", minCh: 13, maxCh: 14, channelNameFormat: "C{ch}" },
      () => [{ name: "ケーブル14", serviceId: 1, type: 1 }]
    );

    // C13 / C14 は CATV の既存の設定を引き継ぎ、スキャンしない
    assert.deepStrictEqual(tuned, []);
    assert.deepStrictEqual(saved.map(item => item.name), ["TER13", "CATV13", "CATV14", "BS01"]);
  });
});
