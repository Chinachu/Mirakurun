/*
   Copyright 2026 kanreisa

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
const { it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-channel-config-"));
process.env.CHANNELS_CONFIG_PATH = path.join(dir, "channels.yml");
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: {}
} } };
const _ = require("../lib/Mirakurun/_").default;
const Channel = require("../lib/Mirakurun/Channel").default;
const config = require("../lib/Mirakurun/config");
const apiUtils = require("../lib/Mirakurun/api");
const channels = require("../lib/Mirakurun/api/config/channels");
const event = require("../lib/Mirakurun/log");
const createMockResponse = () => ({ status() {}, setHeader() {}, end() {} });

function fixture(t, rows, typeExists = () => true) {
    const previous = { config: _.config, tuner: _.tuner, channel: _.channel };
    _.config = { server: { disableEITParsing: true }, channels: structuredClone(rows) };
    _.tuner = { typeExists };
    const messages = { warn: [], error: [] };
    for (const level of ["info", "warn", "error", "debug"]) {
        t.mock.method(event, level, (...args) => messages[level]?.push(require("node:util").format(...args)));
    }
    const loaded = _.channel = new Channel();
    t.after(async () => {
        _.config = previous.config; _.tuner = previous.tuner; _.channel = previous.channel;
    });
    return { loaded, messages };
}

for (const value of [0, -1, 16, 1.5, NaN, Infinity, "1", null, "", false]) {
    if (![0, null, ""].includes(value)) {
        it(`[channel-config-validation.spec] 範囲外または整数以外のtsmfRelTsを読み込まない (${String(value)})`, async t => {
            const { loaded, messages } = fixture(t, [{ name: "invalid", type: "BS", channel: "C21", tsmfRelTs: value }]);
            assert.equal(loaded.items.length, 0);
            assert.equal(messages.error.length, 1);
            assert.match(messages.error[0], /tsmfRelTs.*1.*15/);
        });
    }
    it(`[channel-config-validation.spec] 不正なtsmfRelTsは書き込む前に400で拒否する (${String(value)})`, async t => {
        const save = t.mock.method(config, "saveChannels", async () => undefined);
        t.mock.method(apiUtils, "responseJSON", async () => undefined);
        const failure = t.mock.method(apiUtils, "responseError", () => undefined);
        await channels.put({ body: [{ name: "invalid", type: "BS", channel: "C21", tsmfRelTs: value }], query: {} }, createMockResponse());
        assert.equal(save.mock.callCount(), 0);
        assert.equal(failure.mock.callCount(), 1);
        assert.equal(failure.mock.calls[0].arguments[1], 400);
        assert.match(failure.mock.calls[0].arguments[2], /tsmfRelTs.*1.*15/);
    });
}

for (const value of [0, null, ""]) {
    it(`[channel-config-validation.spec] 旧設定のtsmfRelTs:${JSON.stringify(value)}は元設定を変えず未指定として読み込む`, async t => {
        const { loaded, messages } = fixture(t, [{ name: "legacy", type: "BS", channel: "C21", tsmfRelTs: value }]);
        assert.equal(loaded.items.length, 1);
        assert.equal(loaded.items[0].tsmfRelTs, undefined);
        assert.equal(loaded.items[0].toJSON().tsmfRelTs, undefined);
        assert.equal(loaded.items[0].defaultRelTs, undefined);
        assert.equal(_.config.channels[0].tsmfRelTs, value);
        assert.deepEqual(messages.error, []);
    });
}


for (const value of [undefined, 1, 15]) {
    it(`[channel-config-validation.spec] 未指定と1から15のtsmfRelTsは読み込み・保存できる (${String(value)})`, async t => {
        const row = { name: "valid", type: "BS", channel: "C21", ...(value !== undefined && { tsmfRelTs: value }) };
        const { loaded, messages } = fixture(t, [row]);
        assert.equal(loaded.items.length, 1);
        assert.deepEqual(messages.error, []);
        assert.equal(loaded.items[0].tsmfRelTs, value);
        const save = t.mock.method(config, "saveChannels", async () => undefined);
        t.mock.method(apiUtils, "responseJSON", async () => undefined);
        await channels.put({ body: [row], query: {} }, createMockResponse());
        assert.equal(save.mock.callCount(), 1);
        assert.deepEqual(save.mock.calls[0].arguments[0], [row]);
    });
}

it("[channel-config-validation.spec] 同じtype/channelの別経路の有効行を無視するとき警告する", async t => {
    const { loaded, messages } = fixture(t, [
        { name: "first", type: "BS4K", channel: "C21", route: "CATV", serviceId: 101 },
        { name: "second service", type: "BS4K", channel: "C21", route: "CATV", serviceId: 102 },
        { name: "other route", type: "BS4K", channel: "C21", route: "FTTH", serviceId: 103 }
    ]);
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].route, "CATV");
    assert.equal(messages.warn.length, 1);
    assert.match(messages.warn[0], /BS4K.*C21.*CATV.*FTTH/);
});

it("[channel-config-validation.spec] 同経路のserviceId行と無効・未対応経路の行は重複警告にしない", async t => {
    const { loaded, messages } = fixture(t, [
        { name: "first", type: "BS", channel: "1", serviceId: 101 },
        { name: "second service", type: "BS", channel: "1", route: "SAT", serviceId: 102 },
        { name: "disabled route", type: "BS", channel: "1", route: "CATV", serviceId: 103, isDisabled: true },
        { name: "unsupported route", type: "BS", channel: "1", route: "FTTH", serviceId: 104 }
    ], (_type, route) => route !== "FTTH");
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].route, "SAT");
    assert.deepEqual(messages.warn, []);
});

it("[channel-config-validation.spec] 並行保存の後に最新の設定を同じキュー内で統合する", async () => {
    const original = [{ name: "original", type: "BS", channel: "C21", serviceId: 101 }];
    const latest = [{ name: "latest", type: "BS", channel: "C21", serviceId: 102 }];
    const added = { name: "scanned", type: "BS", channel: "C22", serviceId: 103 };
    await config.saveChannels(original);
    const pendingSave = config.saveChannels(latest);
    const pendingMerge = config.mergeAndSaveChannels(current => {
        assert.deepEqual(current, latest);
        return [...current, added];
    });
    const [, merged] = await Promise.all([pendingSave, pendingMerge]);
    assert.deepEqual(merged, [...latest, added]);
    assert.deepEqual(yaml.load(fs.readFileSync(process.env.CHANNELS_CONFIG_PATH, "utf8")), merged);
});

it("[channel-config-validation.spec] 最新設定の統合が失敗した場合は既存ファイルを保存し直さない", async () => {
    const latest = [{ name: "latest", type: "BS", channel: "C21", serviceId: 102 }];
    await config.saveChannels(latest);
    await assert.rejects(config.mergeAndSaveChannels(() => { throw new Error("merge failed"); }), /merge failed/);
    assert.deepEqual(yaml.load(fs.readFileSync(process.env.CHANNELS_CONFIG_PATH, "utf8")), latest);
});

it("[channel-config-validation.spec] 統合用の最新設定を読んでいる間は並行PUTの保存を待たせる", async t => {
    const fsPromises = require("node:fs/promises");
    const original = [{ name: "original", type: "BS", channel: "C21", serviceId: 101 }];
    const latest = [{ name: "parallel PUT", type: "BS", channel: "C22", serviceId: 102 }];
    const added = { name: "scanned", type: "BS", channel: "C23", serviceId: 103 };
    await config.saveChannels(original);
    let resolveStarted;
    let resume;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const paused = new Promise(resolve => { resume = resolve; });
    const readFile = fsPromises.readFile;
    t.mock.method(fsPromises, "readFile", async (...args) => {
        if (args[0] === process.env.CHANNELS_CONFIG_PATH) { resolveStarted(); await paused; }
        return readFile(...args);
    });
    const merging = config.mergeAndSaveChannels(current => [...current, added]);
    await started;
    let saved = false;
    const saving = config.saveChannels(latest).then(() => { saved = true; });
    await new Promise(resolve => setImmediate(resolve));
    const savedDuringMergeRead = saved;
    resume();
    const [merged] = await Promise.all([merging, saving]);
    assert.equal(savedDuringMergeRead, false);
    assert.deepEqual(merged, [...original, added]);
    assert.deepEqual(yaml.load(fs.readFileSync(process.env.CHANNELS_CONFIG_PATH, "utf8")), latest);
});

for (const value of [0, null, ""]) {
    it(`[channel-config-validation.spec] ChannelItemのJSONでは旧tsmfRelTs:${JSON.stringify(value)}を未指定として公開する`, async t => {
        const { loaded } = fixture(t, [{ name: "legacy", type: "BS", channel: "C21" }]);
        const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
        const item = new ChannelItem({ name: "legacy", type: "BS", channel: "C21", tsmfRelTs: value });
        assert.equal(item.tsmfRelTs, undefined);
        assert.equal(item.toJSON().tsmfRelTs, undefined);
        assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(item)), "tsmfRelTs"), false);
        assert.equal(loaded.items.length, 1);
    });
}


for (const value of [0, null, ""]) {
    it(`[channel-config-validation.spec] 旧${JSON.stringify(value)}のGET応答を編集してPUTしても再保存でき元の読込値は変更しない`, async t => {
        const rows = [
            { name: "legacy", type: "BS", channel: "C21", tsmfRelTs: value },
            { name: "specified", type: "BS", channel: "C22", tsmfRelTs: 2 }
        ];
        t.mock.method(config, "loadChannels", async () => rows);
        let body;
        t.mock.method(apiUtils, "responseJSON", async (_res, value) => { body = JSON.parse(JSON.stringify(value)); });
        const save = t.mock.method(config, "saveChannels", async () => undefined);
        const failure = t.mock.method(apiUtils, "responseError", () => undefined);
        await channels.get({}, createMockResponse());
        assert.equal(Object.hasOwn(body[0], "tsmfRelTs"), false);
        assert.equal(body[1].tsmfRelTs, 2);
        assert.equal(rows[0].tsmfRelTs, value);
        body[0].name = "renamed";
        await channels.put({ body, query: {} }, createMockResponse());
        assert.equal(failure.mock.callCount(), 0);
        assert.equal(save.mock.callCount(), 1);
        assert.equal(save.mock.calls[0].arguments[0][0].name, "renamed");
        assert.equal(Object.hasOwn(save.mock.calls[0].arguments[0][0], "tsmfRelTs"), false);
    });
}

it("[channel-config-validation.spec] 別の行の編集でも既存の範囲外値は該当行の修正後に保存する", async t => {
    const rows = [
        { name: "valid", type: "BS", channel: "C20", tsmfRelTs: 1 },
        { name: "invalid", type: "BS", channel: "C21", tsmfRelTs: 16 }
    ];
    t.mock.method(config, "loadChannels", async () => rows);
    let body;
    t.mock.method(apiUtils, "responseJSON", async (_res, value) => { body = JSON.parse(JSON.stringify(value)); });
    const save = t.mock.method(config, "saveChannels", async () => undefined);
    const failure = t.mock.method(apiUtils, "responseError", () => undefined);
    await channels.get({}, createMockResponse());
    assert.equal(body[1].tsmfRelTs, 16, "不正な値を未指定に変えて受信入力を変えません");
    body[0].name = "renamed";
    await channels.put({ body, query: {} }, createMockResponse());
    assert.equal(save.mock.callCount(), 0);
    assert.equal(failure.mock.callCount(), 1);
    assert.equal(failure.mock.calls[0].arguments[1], 400);
    assert.match(failure.mock.calls[0].arguments[2], /2行目.*tsmfRelTs/);
    body[1].tsmfRelTs = 15;
    await channels.put({ body, query: {} }, createMockResponse());
    assert.equal(failure.mock.callCount(), 1);
    assert.equal(save.mock.callCount(), 1);
    assert.deepEqual(save.mock.calls[0].arguments[0], body);
    assert.equal(rows[1].tsmfRelTs, 16, "読込元の共有設定は書き換えません");
});
