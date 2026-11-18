/*
   Copyright 2026 Mirakurun contributors

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
async function runScan(query, scanChannel, { types = ["GR", "BS", "CS", "BS4K"], dvbChannels = [], logs = [], scanTypes, routes, relTsByRemote = [], extraChannels = [], observeLoad, device = type => `tuner of ${type}` } = {}) {
  const saved = [];
  const tuned = [];
  const errors = [];
  config.loadChannels = async () => {
    const items = [...oldChannels, ...extraChannels].map(item => ({ ...item }));
    observeLoad?.(items);
    return items;
  };
  config.saveChannels = async items => { saved.push(items); };
  config.mergeAndSaveChannels = async merge => {
    const items = merge(await config.loadChannels());
    saved.push(items);
    return items;
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
    backup = { loadChannels: config.loadChannels, saveChannels: config.saveChannels, mergeAndSaveChannels: config.mergeAndSaveChannels, tuner: _.tuner, responseError: api.responseError };
  });
  after(() => {
    config.loadChannels = backup.loadChannels;
    config.saveChannels = backup.saveChannels;
    config.mergeAndSaveChannels = backup.mergeAndSaveChannels;
    _.tuner = backup.tuner;
    api.responseError = backup.responseError;
  });

  for (const dryRun of [false, true]) {
    it(`今回範囲の新規取得だけを集計し同じ経路の範囲外行を引継ぎ件数に含めない (dryRun=${dryRun})`, async () => {
      const outside = { name: "outside TER", type: "GR", channel: "14", serviceId: 114 };
      const result = await runScan({ route: "TER", source: "list", channels: ["13"], refresh: true, dryRun },
        () => [{ format: "ts", services: [service(0x7FE0, 101, "updated TER13")] }], { extraChannels: [outside] });
      assert.deepStrictEqual(result.errors, []);
      const status = await readStatus();
      assert.strictEqual(status.status, "completed");
      assert.strictEqual(status.newCount, 1);
      assert.strictEqual(status.takeoverCount, 0);
      assert.deepStrictEqual(status.result.find(row => row.channel === "14" && row.type === "GR"), outside);
      assert.deepStrictEqual(result.tuned.map(item => item.channel), ["13"]);
    });
    for (const mode of ["skip", "not-refresh"]) {
      it(`今回範囲の有効な既存行の引継ぎは空取得で拒否せず、その件数だけを集計する (${mode}, dryRun=${dryRun})`, async () => {
        const outside = { name: "outside TER", type: "GR", channel: "14", serviceId: 114 };
        const result = await runScan({ route: "TER", source: "list", channels: ["13"], refresh: mode === "skip", dryRun,
          ...(mode === "skip" && { skipCh: ["13"] }) }, () => { assert.fail("引継ぎ対象は選局しません"); }, { extraChannels: [outside] });
        assert.deepStrictEqual(result.errors, []);
        const status = await readStatus();
        assert.strictEqual(status.status, "completed");
        assert.strictEqual(status.newCount, 0);
        assert.strictEqual(status.takeoverCount, 1);
        assert.deepStrictEqual(status.result.find(row => row.channel === "13" && row.type === "GR"), oldChannels[0]);
        assert.deepStrictEqual(status.result.find(row => row.channel === "14" && row.type === "GR"), outside);
        assert.deepStrictEqual(result.tuned, []);
      });
    }
  }

  it("部分失敗で保持した範囲内の複数種別だけを引継ぎ件数へ含める", async () => {
    const result = await runScan({ route: "CATV", source: "list", channels: ["C14"], refresh: true },
      () => [{ format: "ts", networkId: 4, services: [], failed: true }]);
    assert.deepStrictEqual(result.errors, []);
    const status = await readStatus();
    assert.strictEqual(status.status, "completed");
    assert.strictEqual(status.newCount, 0);
    assert.strictEqual(status.takeoverCount, 2);
    assert.deepStrictEqual(status.result.filter(row => row.channel === "C14"), oldChannels.filter(row => row.channel === "C14"));
    assert.ok(status.result.some(row => row.channel === "C13"));
  });

  it("最終読込で明示削除された引継ぎ行を復活させず、範囲外行も引継ぎ件数に数えない", async () => {
    let reads = 0;
    const outside = { name: "outside TER", type: "GR", channel: "14", serviceId: 114 };
    const result = await runScan({ route: "TER", source: "list", channels: ["13"], refresh: false },
      () => { assert.fail("有効な既存行は選局しません"); }, {
        extraChannels: [outside], observeLoad(rows) {
          if (++reads > 1) { const index = rows.findIndex(row => row.channel === "13" && row.type === "GR"); if (index !== -1) rows.splice(index, 1); }
        }
      });
    assert.deepStrictEqual(result.errors, []);
    const status = await readStatus();
    assert.strictEqual(status.status, "completed");
    assert.strictEqual(status.newCount, 0);
    assert.strictEqual(status.takeoverCount, 0);
    assert.strictEqual(status.result.some(row => row.channel === "13" && row.type === "GR"), false);
    assert.deepStrictEqual(status.result.find(row => row.channel === "14" && row.type === "GR"), outside);
  });

  for (const skipCh of [[" 14 "], ["14\t"], [" \t14\r\n", " "], [" 14 ", "14", ""], ["14"]]) {
    it(`skipChの前後空白と空項目を除き、省略した既存行を保持する (${JSON.stringify(skipCh)})`, async () => {
      const original = [...skipCh];
      const existing = { name: "skip retained", type: "GR", channel: "14", serviceId: 114 };
      const { tuned, saved, errors } = await runScan(
        { route: "TER", source: "list", channels: ["13", "14", "15"], skipCh, refresh: true },
        channel => [{ format: "ts", services: [service(0x7FE0, 901, `updated ${channel.channel}`)] }],
        { extraChannels: [existing] }
      );
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(tuned.map(item => item.channel), ["13", "15"]);
      assert.deepStrictEqual(saved.find(item => item.channel === "14" && item.type === "GR"), existing);
      assert.deepStrictEqual(skipCh, original, "受付後も呼出し元の配列は変更しません");
    });
  }
  it("skipChの空項目だけなら全チャンネルを走査する", async () => {
    const { tuned, errors } = await runScan(
      { route: "TER", source: "list", channels: ["13", "14"], skipCh: ["", " ", "\t"], refresh: true },
      channel => [{ format: "ts", services: [service(0x7FE0, 901, `updated ${channel.channel}`)] }]
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(tuned.map(item => item.channel), ["13", "14"]);
  });
  it("skipChは内部の空白や数字の表記を変えず識別子全体で照合する", async () => {
    const { tuned, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C13", "C 14", "C14", "4-", "73750", "0014"], skipCh: [" C 14 ", " 4- ", " 73750 ", " 14 "], refresh: true },
      channel => [{ format: "ts", services: [service(0x7FE0, 901, `updated ${channel.channel}`)] }]
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(tuned.map(item => item.channel), ["C13", "C14", "0014"]);
  });
  it("skipChを従来のtype指定でもtrimして主番号を省略する", async () => {
    const { tuned, errors } = await runScan(
      { type: "GR", minCh: 13, maxCh: 15, skipCh: [" 14 ", ""], refresh: true },
      channel => [{ format: "ts", services: [service(0x7FE0, 901, `updated ${channel.channel}`)] }]
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(tuned.map(item => item.channel), ["13", "15"]);
  });

  for (const [route, existingChannel, receivedNetworkId, nextChannel, acceptedNetworkId] of [
    ["TER", "13", 0xFFFE, "14", 0x7FE0],
    ["SAT", "BS01_0", 10, "BS03_0", 4]
  ]) {
    for (const failed of [false, true]) {
      for (const serviceType of [1, 0xA2]) {
        it(`経路外ネットワークは既存行を消す根拠にせず、他チャンネルの取得結果を保存する (${route}, failed:${failed}, serviceType:${serviceType})`, async () => {
          const { saved, errors } = await runScan(
            { route, source: "list", channels: [existingChannel, nextChannel], refresh: true },
            channel => channel.channel === existingChannel
              ? [{ format: "ts", networkId: receivedNetworkId, services: [{ ...service(receivedNetworkId, 901, "outside route"), type: serviceType }], failed }]
              : [{ format: "ts", services: [service(acceptedNetworkId, 902, "new service")] }]
          );
          assert.deepStrictEqual(errors, []);
          assert.deepStrictEqual(saved.filter(item => item.channel === existingChannel && (item.route ?? (item.type === "GR" ? "TER" : "SAT")) === route),
            oldChannels.filter(item => item.channel === existingChannel));
          assert.strictEqual(saved.some(item => item.channel === existingChannel && item.serviceId === 901), false);
          assert.strictEqual(saved.some(item => item.channel === nextChannel && item.name === "new service"), true);
        });
      }
    }
  }

  it("対象サービス種別が0件の非TSMFでも未絞込のnetworkIdで判定し旧行を削除する", async () => {
    const logs = [];
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C14", "C22"], refresh: true },
      channel => channel.channel === "C14"
        ? [{ format: "ts", services: [{ ...service(4, 301, "not selected"), type: 0xA2 }] }]
        : [{ format: "ts", services: [service(4, 102, "new BS")] }],
      { logs }
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.channel === "C14"), []);
    assert.strictEqual(saved.find(item => item.channel === "C22").serviceId, 102);
    assert.strictEqual(logs.join("").includes("unknown network"), false);
  });

  for (const failed of [false, true]) {
    for (const reverse of [false, true]) {
      it(`未知相対TSは未観測種別だけ保持し既知種別の移転と廃止を反映する (failed:${failed}, reverse:${reverse})`, async () => {
        const previous = [
          { name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101, tsmfRelTs: 1 },
          { name: "obsolete BS", type: "BS", channel: "C21", route: "CATV", serviceId: 999, tsmfRelTs: 1 },
          { name: "old 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211, tsmfRelTs: 2 }
        ];
        const streams = [
          { relTs: 3, format: "ts", services: [service(4, 101, "new BS")] },
          { relTs: 4, format: "ts", networkId: 0x1234, services: [], failed }
        ];
        const { saved, errors } = await runScan(
          { route: "CATV", source: "list", channels: ["C21"], refresh: true },
          () => reverse ? [...streams].reverse() : streams,
          { extraChannels: previous }
        );
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(saved.filter(item => item.channel === "C21" && item.type === "BS"), [
          { name: "new BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101, tsmfRelTs: 3, isDisabled: true }
        ]);
        assert.deepStrictEqual(saved.filter(item => item.channel === "C21" && item.type === "BS4K"), [previous[2]]);
      });
    }
  }

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

  it("部分失敗した相対TSの既存サービス行を残し、取得できた種別だけ置き換える", async () => {
    const previousBs = { name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101 };
    const previousTlv = { name: "old 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211, isDisabled: false, commandVars: { space: 7 } };
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => [
        { relTs: 1, format: "ts", services: [service(4, 101, "new BS")] },
        { relTs: 2, format: "tlv", services: [], failed: true }
      ],
      { extraChannels: [previousBs, previousTlv] }
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), [
      { name: "new BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101, isDisabled: true, tsmfRelTs: 1 },
      previousTlv
    ]);
  });

  for (const route of ["CATV", "FTTH"]) {
    it(`${route}の一部種別だけ取得が失敗したとき、同じチャンネルの未観測種別も保持する`, async () => {
      const previous = [
        { name: "old terrestrial", type: "GR", channel: "C21", route, serviceId: 201, isDisabled: false },
        { name: "old BS", type: "BS", channel: "C21", route, serviceId: 101 }
      ];
      const otherRoute = { name: "other route", type: "CS", channel: "C21", route: route === "CATV" ? "FTTH" : "CATV", serviceId: 301 };
      const { saved, errors } = await runScan(
        { route, source: "list", channels: ["C21"], refresh: true },
        () => [{ relTs: 1, format: "ts", networkId: 4, services: [], failed: true }],
        { extraChannels: [...previous, otherRoute] }
      );
      assert.deepStrictEqual(errors, []);
      const sort = items => items.sort((a, b) => a.type.localeCompare(b.type));
      assert.deepStrictEqual(sort(saved.filter(item => item.channel === "C21" && item.route === route)), sort([...previous]));
      assert.deepStrictEqual(saved.filter(item => item.name === "other route"), [otherRoute]);
    });
  }

  it("部分失敗の未観測種別だけを保護し、取得成功した種別と他チャンネルは置き換える", async () => {
    const previous = [
      { name: "old terrestrial", type: "GR", channel: "C21", route: "CATV", serviceId: 201 },
      { name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101 },
      { name: "removed BS", type: "BS", channel: "C21", route: "CATV", serviceId: 102 },
      { name: "old 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211 },
      { name: "other channel CS", type: "CS", channel: "C22", route: "CATV", serviceId: 301 }
    ];
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C21", "C22"], refresh: true },
      channel => channel.channel === "C21" ? [
        { relTs: 1, format: "ts", services: [service(4, 101, "new BS")] },
        { relTs: 2, format: "tlv", networkId: 11, services: [], failed: true }
      ] : [{ format: "ts", services: [service(0x7FE0, 302, "new terrestrial")] }],
      { extraChannels: previous }
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), [
      previous[0], { name: "new BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101, tsmfRelTs: 1, isDisabled: true }, previous[3]
    ]);
    assert.deepStrictEqual(saved.filter(item => item.channel === "C22"), [
      { name: "new terrestrial", type: "GR", channel: "C22", route: "CATV", isDisabled: false }
    ]);
  });

  it("部分失敗時も、サービスなしで取得成功した既知種別は未観測とみなさない", async () => {
    const previous = [
      { name: "old terrestrial", type: "GR", channel: "C21", route: "CATV", serviceId: 201 },
      { name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101 }
    ];
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => [
        { relTs: 1, format: "ts", networkId: 0x7FE0, services: [] },
        { relTs: 2, format: "ts", networkId: 4, services: [], failed: true }
      ],
      { extraChannels: previous }
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), [previous[1]]);
  });

  it("取得成功だけなら、同じチャンネルで観測しなかった旧種別を従来どおり置き換える", async () => {
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C14"], refresh: true },
      () => [{ format: "ts", services: [service(4, 102, "new BS")] }]
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.channel === "C14"), [
      { name: "new BS", type: "BS", channel: "C14", route: "CATV", serviceId: 102, isDisabled: true }
    ]);
  });

  it("部分失敗で未観測の種別も保存時の最新行だけを保持する", async () => {
    const extraChannels = [
      { name: "old terrestrial", type: "GR", channel: "C21", route: "CATV", serviceId: 201 },
      { name: "removed CS", type: "CS", channel: "C21", route: "CATV", serviceId: 301 },
      { name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101 }
    ];
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => {
        extraChannels[0].name = "latest terrestrial";
        extraChannels[0].commandVars = { space: 7 };
        extraChannels.splice(1, 1);
        extraChannels.push({ name: "added CATV", type: "CATV", channel: "C21", serviceId: 401 });
        return [{ relTs: 1, format: "ts", networkId: 4, services: [], failed: true }];
      },
      { extraChannels }
    );
    assert.deepStrictEqual(errors, []);
    const sort = items => items.sort((a, b) => a.type.localeCompare(b.type));
    assert.deepStrictEqual(sort(saved.filter(item => item.channel === "C21")), sort([...extraChannels]));
  });

  for (const value of [0, null, ""]) {
    for (const dryRun of [false, true]) {
      it(`部分失敗でも旧相対TS ${JSON.stringify(value)}を未指定として確認済みサービスを${dryRun ? "公開" : "保存"}する`, async () => {
        const previous = [
          Object.freeze({ name: "old received", type: "BS", channel: "C21", route: "CATV", serviceId: 101, tsmfRelTs: value }),
          Object.freeze({ name: "old missing", type: "BS", channel: "C21", route: "CATV", serviceId: 102, tsmfRelTs: value, isDisabled: false })
        ];
        const loaded = [];
        const result = await runScan(
          { route: "CATV", source: "list", channels: ["C21"], refresh: true, dryRun },
          () => [
            { relTs: 1, format: "ts", services: [service(4, 101, "new received"), service(4, 103, "new added")] },
            { relTs: 2, format: "ts", networkId: 4, services: [], failed: true }
          ],
          { extraChannels: previous, observeLoad: items => loaded.push(items) }
        );
        assert.deepStrictEqual(result.errors, []);
        const rows = dryRun ? (await readStatus()).result : result.saved;
        const retained = { ...previous[1] };
        if (dryRun) { delete retained.tsmfRelTs; }
        assert.deepStrictEqual(rows.filter(item => item.channel === "C21").sort((a, b) => a.serviceId - b.serviceId), [
          { name: "new received", type: "BS", channel: "C21", route: "CATV", serviceId: 101, isDisabled: true },
          retained,
          { name: "new added", type: "BS", channel: "C21", route: "CATV", serviceId: 103, isDisabled: true }
        ]);
        assert.ok(loaded.length >= 2, "保存直前の設定も読み直します");
        assert.ok(loaded.every(items => items.filter(item => item.channel === "C21").every(item => item.tsmfRelTs === value)), "共有設定の旧表記を比較のために変更しません");
        assert.ok(previous.every(item => item.tsmfRelTs === value));
      });
    }
  }

  it("同種別の一部相対TSが失敗しても、未取得のserviceId行を失わない", async () => {
    const previous = [
      { name: "old received", type: "BS", channel: "C21", route: "CATV", serviceId: 101 },
      { name: "old missing", type: "BS", channel: "C21", route: "CATV", serviceId: 102, isDisabled: false }
    ];
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => [
        { relTs: 1, format: "ts", services: [service(4, 101, "new received")] },
        { relTs: 2, format: "ts", networkId: 4, services: [], failed: true }
      ],
      { extraChannels: previous }
    );
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21").sort((a, b) => a.serviceId - b.serviceId), [
      { name: "new received", type: "BS", channel: "C21", route: "CATV", serviceId: 101, isDisabled: true },
      previous[1]
    ]);
  });

  for (const route of ["SAT", "CATV"]) {
    it(`${route}の複数搬送波で未取得のサービス行を空の無効行へ置換しない`, async () => {
      const channel = route === "SAT" ? "BS01_0" : "C21";
      const previous = { name: "registered 4K", type: "BS4K", channel, serviceId: 211, isDisabled: false,
        tsmfRelTs: 1, tsmfGroupId: 7, commandVars: { satellite: 3 }, ...(route === "CATV" && { route }) };
      const { saved, errors } = await runScan(
        { route, source: "list", channels: [channel], refresh: true },
        () => [{ relTs: 1, format: "tlv", services: [], numberOfCarriers: 2 }],
        { extraChannels: [previous] }
      );
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(saved.filter(item => item.type === "BS4K" && item.channel === channel), [previous]);
    });
  }

  it("未登録の複数搬送波は後続スキャンで利用できる有効な行として追加する", async () => {
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => [{ relTs: 1, format: "tlv", services: [], numberOfCarriers: 2 }]
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), [
      { name: "BS4KC21", type: "BS4K", channel: "C21", route: "CATV", isDisabled: false }
    ]);
  });

  it("部分失敗した種別は保存時の最新行を保持し、途中で削除された行を復活させない", async () => {
    const extraChannels = [
      { name: "old received", type: "BS", channel: "C21", route: "CATV", serviceId: 101 },
      { name: "old 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211 },
      { name: "removed 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 212 }
    ];
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => {
        extraChannels[1].name = "latest 4K";
        extraChannels[1].isDisabled = false;
        extraChannels.splice(2, 1);
        return [
          { relTs: 1, format: "ts", services: [service(4, 101, "new BS")] },
          { relTs: 2, format: "tlv", services: [], failed: true }
        ];
      },
      { extraChannels }
    );
    assert.deepStrictEqual(saved.filter(item => item.type === "BS4K" && item.channel === "C21"), [extraChannels[1]]);
  });

  it("未取得種別の行がスキャン中に追加された場合は空の搬送波行で上書きしない", async () => {
    const extraChannels = [];
    const latest = { name: "added 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211, isDisabled: false };
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => { extraChannels.push(latest); return [{ relTs: 1, format: "tlv", services: [], numberOfCarriers: 2 }]; },
      { extraChannels }
    );
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), [latest]);
  });

  it("未取得の複数搬送波行がスキャン中に削除された場合は空行としても復活させない", async () => {
    const extraChannels = [{ name: "removed 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211 }];
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => { extraChannels.length = 0; return [{ relTs: 1, format: "tlv", services: [], numberOfCarriers: 2 }]; },
      { extraChannels }
    );
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), []);
  });

  it("部分失敗ではサービス単位の旧行をチャンネル単位へ広げない", async () => {
    const previous = { name: "restricted BS", type: "BS", channel: "C21", route: "CATV", serviceId: 102, isDisabled: false };
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true, scanMode: "Channel" },
      () => [
        { relTs: 1, format: "ts", services: [service(4, 101, "new BS")] },
        { relTs: 2, format: "ts", networkId: 4, services: [], failed: true }
      ],
      { extraChannels: [previous] }
    );
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), [previous]);
  });

  it("部分失敗では相対TSを限定した旧行を別の相対TSで置き換えない", async () => {
    const previous = { name: "selected BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101, tsmfRelTs: 2, isDisabled: false };
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => [
        { relTs: 1, format: "ts", services: [service(4, 101, "different stream")] },
        { relTs: 2, format: "ts", networkId: 4, services: [], failed: true }
      ],
      { extraChannels: [previous] }
    );
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), [previous]);
  });

  it("種別不明の相対TS取得失敗では同じチャンネルの全種別を保護する", async () => {
    const previous = [
      { name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101 },
      { name: "old terrestrial", type: "GR", channel: "C21", route: "CATV", serviceId: 201 },
      { name: "old CS", type: "CS", channel: "C21", route: "CATV", serviceId: 202 },
      { name: "old 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211 }
    ];
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => [
        { relTs: 1, format: "ts", services: [service(4, 101, "new BS")] },
        { relTs: 2, format: "ts", networkId: 0x1234, services: [], failed: true }
      ],
      { extraChannels: previous }
    );
    assert.deepStrictEqual(errors, []);
    const sort = items => items.sort((a, b) => a.type.localeCompare(b.type));
    assert.deepStrictEqual(sort(saved.filter(item => item.channel === "C21")), sort([
      { name: "new BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101, tsmfRelTs: 1, isDisabled: true },
      ...previous.slice(1)
    ]));
  });

  for (const unknownServices of [[], [service(0x1234, 999, "unknown service")]]) {
    it(`種別不明の取得成功でも既存行を保持し、他チャンネルの取得結果だけを保存する (services:${unknownServices.length})`, async () => {
      const previous = [
        { name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101, tsmfRelTs: 1, isDisabled: false },
        { name: "old 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211, isDisabled: false }
      ];
      const { saved, errors } = await runScan(
        { route: "CATV", source: "list", channels: ["C21", "C22"], refresh: true },
        channel => channel.channel === "C21"
          ? [{ relTs: 2, format: "ts", networkId: 0x1234, services: unknownServices }]
          : [{ format: "ts", services: [service(4, 102, "new BS")] }],
        { extraChannels: previous }
      );
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), previous);
      assert.deepStrictEqual(saved.filter(item => item.channel === "C22"), [
        { name: "new BS", type: "BS", channel: "C22", route: "CATV", serviceId: 102, isDisabled: true }
      ]);
    });
  }

  it("成功した種別と種別不明の成功ストリームが混在しても他種別の旧行を消さない", async () => {
    const previous = [
      { name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101 },
      { name: "old 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211 }
    ];
    const { saved, errors } = await runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => [
        { relTs: 1, format: "ts", services: [service(4, 101, "new BS")] },
        { relTs: 2, format: "ts", networkId: 0x1234, services: [service(0x1234, 999, "unknown service")] }
      ],
      { extraChannels: previous }
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), [
      { name: "new BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101, tsmfRelTs: 1, isDisabled: true }, previous[1]
    ]);
  });

  it("経路外と判定した失敗相対TSでも既存サービス行を削除しない", async () => {
    const previous = { name: "old terrestrial", type: "GR", channel: "27", serviceId: 201, isDisabled: false };
    const otherType = { name: "configured BS", type: "BS", channel: "27", route: "TER", serviceId: 301 };
    const { saved, errors } = await runScan(
      { route: "TER", source: "list", channels: ["27"], refresh: true, scanMode: "Service" },
      () => [
        { relTs: 1, format: "ts", services: [service(0x7880, 202, "new terrestrial")] },
        { relTs: 2, format: "ts", networkId: 4, services: [], failed: true }
      ],
      { extraChannels: [previous, otherType] }
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.channel === "27").sort((a, b) => a.serviceId - b.serviceId), [
      previous, { name: "new terrestrial", type: "GR", channel: "27", serviceId: 202, tsmfRelTs: 1, isDisabled: false }, otherType
    ]);
  });

  for (const [query, reason] of [
    [{ route: "SKY", source: "preset" }, "SKYにはプリセットがありません。チャンネル一覧、dvbv5設定ファイル、または書式を指定してください。"],
    [{ route: "CATV", source: "list", channels: [] }, "スキャンするチャンネルを1件以上指定してください。"],
    [{ route: "CATV", source: "list", channels: [" ", "\t"] }, "スキャンするチャンネルを1件以上指定してください。"],
    [{ route: "CATV", source: "format", minCh: 13, maxCh: 15, channelNameFormat: "" }, "チャンネル名の書式を指定してください。"],
    [{ route: "CATV", source: "format", minCh: 13, maxCh: 15, channelNameFormat: "  " }, "チャンネル名の書式を指定してください。"],
    [{ route: "CATV", source: "format", channelNameFormat: "C{ch}" }, "書式から取得する開始番号と終了番号を指定してください。"]
  ]) {
    it(`無効なスキャン指定は開始前に理由付き400を返す (${JSON.stringify(query)})`, async () => {
      const { saved, tuned, errors } = await runScan(query, () => [], { types: ["SKY", "GR", "BS", "CS", "BS4K"] });
      assert.deepStrictEqual(errors, [{ code: 400, reason }]);
      assert.deepStrictEqual(tuned, []);
      assert.strictEqual(saved, undefined);
      const noTuners = await runScan(query, () => [], { types: [] });
      assert.deepStrictEqual(noTuners.errors, [{ code: 400, reason }]);
    });
  }

  it("相対TSの取得待機中に編集・削除・追加した行を最新設定から統合する", async () => {
    const extraChannels = [
      { name: "old 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 211 },
      { name: "removed 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 212 }
    ];
    let resolveStarted;
    let resume;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const pending = new Promise(resolve => { resume = resolve; });
    const scanning = runScan(
      { route: "CATV", source: "list", channels: ["C21"], refresh: true },
      () => { resolveStarted(); return pending; },
      { extraChannels }
    );
    await started;
    extraChannels[0].name = "edited 4K";
    extraChannels.splice(1, 1);
    extraChannels.push({ name: "added 4K", type: "BS4K", channel: "C21", route: "CATV", serviceId: 213 });
    resume([
      { relTs: 1, format: "ts", services: [service(4, 101, "new BS")] },
      { relTs: 2, format: "tlv", services: [], failed: true }
    ]);
    const { saved, errors } = await scanning;
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(saved.filter(item => item.type === "BS4K" && item.channel === "C21"), extraChannels);
  });

  it("チャンネル取得に失敗した場合は最新の既存行を保持する", async () => {
    const extraChannels = [{ name: "old BS", type: "BS", channel: "C21", route: "CATV", serviceId: 101 }];
    const { saved } = await runScan(
      { route: "CATV", source: "list", channels: ["C21", "C22"], refresh: true },
      channel => {
        if (channel.channel === "C21") {
          extraChannels[0].name = "latest BS";
          throw new Error("stream has closed before get network");
        }
        return [{ format: "ts", services: [service(4, 102, "new BS")] }];
      },
      { extraChannels }
    );
    assert.deepStrictEqual(saved.filter(item => item.channel === "C21"), extraChannels);
    assert.strictEqual(saved.find(item => item.channel === "C22").name, "new BS");
  });

  for (const [name, value] of [["minCh", 13], ["maxCh", 20], ["minSubCh", 0], ["maxSubCh", 3], ["channelNameFormat", "C{ch}"]]) {
    it(`source=listで使用しない${name}は取得・保存前に拒否する`, async () => {
      const result = await runScan({ route: "CATV", source: "list", channels: ["C13"], [name]: value }, () => []);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.errors[0].code, 400);
      assert.ok(result.errors[0].reason.includes(name));
      assert.ok(result.errors[0].reason.includes("source=list"));
      assert.deepStrictEqual(result.tuned, []);
      assert.strictEqual(result.saved, undefined);
    });
  }

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

  for (const dryRun of [false, true]) {
    for (const change of ["add", "remove", "disable", "enable"]) {
      it(`受信待ち中の別経路編集を最終統合に使う (${change}, dryRun:${dryRun})`, async () => {
        const other = { name: "other route", type: "GR", channel: "C21", route: "TER", isDisabled: false };
        const before = change === "add" ? [] : [{ ...other, isDisabled: change === "enable" }];
        const after = change === "remove" ? [] : [{ ...other, isDisabled: change === "disable" }];
        let current = before;
        const started = Promise.withResolvers(), received = Promise.withResolvers();
        const scanning = runScan(
          { route: "CATV", source: "list", channels: ["C21", "C22"], refresh: true, dryRun },
          async channel => {
            if (channel.channel === "C21") { started.resolve(); await received.promise; }
            return [{ format: "ts", services: [service(0x7FE0, 1, `new ${channel.channel}`)] }];
          },
          { observeLoad: items => { items.splice(0, items.length, ...current.map(item => ({ ...item }))); } }
        );
        await started.promise;
        // 選局中の別リクエストによる設定編集。保存・dryRunの再読込で初めて見えるようにします。
        current = after;
        received.resolve();
        const result = await scanning;
        assert.deepStrictEqual(result.errors, []);
        const rows = dryRun ? (await readStatus()).result : result.saved;
        const matching = rows.filter(item => item.channel === "C21");
        const discovered = { name: "new C21", type: "GR", channel: "C21", route: "CATV", isDisabled: false };
        const expected = change === "add" || change === "enable" ? after : [...after, discovered];
        const sort = rows => [...rows].sort((a, b) => a.name.localeCompare(b.name));
        assert.deepStrictEqual(sort(matching), sort(expected));
        assert.strictEqual(rows.some(item => item.channel === "C22" && item.route === "CATV"), true);
      });
    }
  }

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
    assert.deepStrictEqual(result.errors, []); // 受付前取消しは400ではなく204で完了する。
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

    // NITで不在を確認できた行だけを削除し、単に取得できなかった行は保持する。
    it("removes only channels confirmed absent by NIT and keeps channels with no signal", async () => {
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
          const confirmedAbsent = new Set([...(source === "dvbConf" ? ["BS23_2"] : []), ...(refresh ? ["BS07_0"] : [])]);
          // listの取得失敗は全行を保持する。NITで不在を確認したBS行だけを除いた全結果と比較する。
          assert.deepStrictEqual(skipped.saved, all.saved.filter(item => !(item.type === "BS" && (item.route === undefined || item.route === "SAT") && confirmedAbsent.has(item.channel))), `${source} ${refresh}`);
          const closedRows = rows => rows.filter(item => item.name === "closed" || item.name === "closed 2").sort((a, b) => a.channel.localeCompare(b.channel));
          assert.deepStrictEqual(closedRows(all.saved), closedRows(extraChannels), "比較元のlistでは無効行も含め、取得失敗した旧行をそのまま保持する");
          assert.strictEqual(skipped.saved.some(item => item.name === "NHK BS"), !refresh);
          // presetの名前だけではBS23_2の不在を確認できない。dvbConfのTSIDならNITから不在と判定できる。
          assert.strictEqual(skipped.saved.some(item => item.name === "closed"), source === "preset");
          assert.strictEqual(skipped.saved.some(item => item.name === "closed 2"), !refresh);
          assert.strictEqual(all.saved.some(item => item.name === "closed"), true);
          assert.strictEqual(all.saved.some(item => item.name === "closed 2"), true);
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

  it("type指定とroute指定の範囲外置換の契約を区別する", async () => {
    const outside = { name: "outside BS", type: "BS", channel: "BS05_0", serviceId: 105 };
    const receive = () => [{ format: "ts", services: [service(4, 101, "BS 101")] }];
    const legacy = await runScan({ type: "BS", minCh: 1, maxCh: 1, minSubCh: 0, maxSubCh: 0, useSubCh: true, refresh: true }, receive, { extraChannels: [outside], scanTypes: ["BS"] });
    assert.deepStrictEqual(legacy.errors, []);
    assert.strictEqual(legacy.saved.some(row => row.channel === "BS05_0"), true);
    const routed = await runScan({ route: "SAT", source: "format", channelNameFormat: "BS{ch00}_{subch}", minCh: 1, maxCh: 1, minSubCh: 0, maxSubCh: 0, refresh: true }, receive, { extraChannels: [outside], scanTypes: ["BS"] });
    assert.deepStrictEqual(routed.errors, []);
    assert.ok(routed.saved.some(row => row.channel === "BS05_0"));
  });

  for (const source of [undefined, "preset", "dvbConf"]) {
    for (const [name, value] of [["minCh", 20], ["maxCh", 30], ["minSubCh", 1], ["maxSubCh", 2], ["channelNameFormat", "C{ch}"]]) {
      it(`source=${source ?? "未指定"}で使用しない${name}を拒否する`, async () => {
        let reads = 0;
        const result = await runScan({ route: "TER", ...(source === undefined ? {} : { source }), [name]: value }, () => [], { dvbChannels: () => { reads++; return ["20"]; } });
        assert.deepStrictEqual(result.errors.map(error => error.code), [400]);
        assert.match(result.errors[0].reason, /source=format/);
        assert.match(result.errors[0].reason, new RegExp(name));
        assert.equal(reads, 0);
        assert.deepStrictEqual(result.tuned, []);
      });
    }
  }

  const readStatus = async () => new Promise((resolve, reject) => {
    Promise.resolve(scan.get({}, { setHeader() {}, status() {}, end(body) { resolve(JSON.parse(body)); } })).catch(reject);
  });

  for (const value of [0, null, ""]) {
    for (const dryRun of [true, false]) {
      it(`旧相対TS ${JSON.stringify(value)}の範囲外保持行を${dryRun ? "dryRun" : "自動保存"}の公開結果だけ未指定にする`, async () => {
        const raw = { name: "legacy C50", type: "GR", channel: "C50", route: "CATV", tsmfRelTs: value };
        const loaded = [];
        const logs = [];
        const result = await runScan({ route: "CATV", source: "list", channels: ["C21"], refresh: true, dryRun },
          () => [{ format: "ts", services: [service(0x7880, 1, "new service")] }],
          { extraChannels: [raw], observeLoad: items => loaded.push(items), logs });
        assert.deepStrictEqual(result.errors, []);
        const status = await readStatus();
        const legacy = status.result.find(item => item.name === raw.name);
        assert.ok(legacy);
        assert.strictEqual(Object.hasOwn(legacy, "tsmfRelTs"), false);
        assert.strictEqual(raw.tsmfRelTs, value);
        assert.ok(loaded.every(items => items.find(item => item.name === raw.name).tsmfRelTs === value), "共有読込結果を正規化のために変更しない");
        if (!dryRun) { assert.strictEqual(result.saved.find(item => item.name === raw.name).tsmfRelTs, value, "保存callbackが使う設定は公開用の正規化で変えない"); }
        assert.ok(logs.some(line => line.includes("(CATV/Any)")));
        assert.ok(logs.every(line => !line.includes("undefined/Any")));
      });
    }
  }

  it("type指定の集計は受信経路ではなく指定種別を表示する", async () => {
    const logs = [];
    await runScan({ type: "BS", minCh: 1, maxCh: 1, minSubCh: 0, maxSubCh: 0, useSubCh: true, refresh: true, dryRun: true },
      () => [{ format: "ts", services: [service(4, 101, "BS service")] }], { scanTypes: ["BS"], logs });
    assert.ok(logs.some(line => line.includes("(BS/Any)")));
  });

});
