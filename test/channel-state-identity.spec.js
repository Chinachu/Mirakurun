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
const { beforeEach, after, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const nativeFS = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const feature = nativeFS.existsSync(path.join(__dirname, "../src/Mirakurun"));
const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
const temporary = nativeFS.mkdtempSync(path.join(os.tmpdir(), "mirakurun-channel-identity-"));
process.env.CHANNELS_DB_PATH = path.join(temporary, "channels.json");
const statusPath = require.resolve(prefix + "/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: { epg: {}, epgByStream: {}, errorCount: {}, streamCount: {} } } };
const logPath = require.resolve(prefix + (feature ? "/log" : "/event-log"));
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require(prefix + "/_").default;
const Channel = require(prefix + "/Channel").default;
const db = require(prefix + "/db");
let ChannelStateModel;
if (!feature) {
    ({ ChannelStateModel } = require(prefix + "/models/ChannelState"));
    require("./helpers/mongo-setup").withMongo({ prefix: "mirakurun-channel-state-identity-", beforeEachModels: [ChannelStateModel] });
}
after(() => fs.rm(temporary, { recursive: true, force: true }));
beforeEach(async () => {
    await fs.rm(process.env.CHANNELS_DB_PATH, { force: true });
    _.config = { server: { disableEITParsing: true }, channels: [
        { name: "Cable A", type: "BS", channel: "C46", route: "CATV" },
        { name: "Cable B", type: "BS", channel: "C47", route: "CATV" }
    ] };
    _.configIntegrity = { channels: "before" };
    _.service = { invalidateChannelIndex() {} };
    _.tuner = { typeExists: () => true };
});
const streams = (sequence = 1) => [{ networkId: 11, streamId: 45000 + sequence, relTs: 5, format: "tlv", slots: 28,
    groupId: 7, numberOfCarriers: 2, carrierSequence: (sequence - 1) % 2 + 1, tsmfNetworkId: 0xFFFE, tsmfStreamId: 0x420 }];
function store(t) {
    const current = new Channel(); _.channel = current;
    t.after(async () => { if (current.close) { await current.close(); } else { clearTimeout(current._saveTimerId); } });
    return current;
}
async function save(current) {
    current.save();
    if (current.flush) { await current.flush(); }
    else { current._save(); await db.loadChannels(_.configIntegrity.channels); clearTimeout(current._saveTimerId); }
}
async function seed(t) {
    const current = store(t);
    current.items[0].setStreams(streams(1)); current.items[1].setStreams(streams(2));
    await save(current);
    return current;
}
async function writeRecords(records, integrity = "before") {
    await db.saveChannels(records, integrity);
    if (feature) { await db.loadChannels(integrity); }
}
it("[channel-state-identity] 名前・serviceId・対象外行変更でも受信設定が同じ経路を復元する", async t => {
    await seed(t);
    const records = await db.loadChannels("before");
    assert.deepEqual(records[0].reception, { route: "CATV", commandVars: {} });
    assert.equal(records[0].reception.tsmfGroupId, undefined, "検出済みgroupではなく設定済みgroupだけを保存します");
    _.config.channels[0].name = "renamed"; _.config.channels[0].serviceId = 101;
    _.config.channels.push({ name: "new", type: "GR", channel: "27" });
    _.configIntegrity.channels = "after";
    const current = store(t); await current.load();
    assert.deepEqual(current.get("BS", "C46").streams, streams(1));
    assert.deepEqual(current.get("BS", "C47").streams, streams(2));
    assert.deepEqual(current.get("GR", "27").streams, []);
});
for (const change of [{ route: "SAT" }, { tsmfRelTs: 3 }, { format: "tlv" }, { tsmfGroupId: 2 }, { commandVars: { satellite: 1 } }, { type: "BS4K" }, { channel: "C48" }]) {
    it(`[channel-state-identity] 受信設定が変わった入力だけ再取得し、他行を復元する (${JSON.stringify(change)})`, async t => {
        await seed(t);
        Object.assign(_.config.channels[0], change); _.configIntegrity.channels = "after";
        const current = store(t); await current.load();
        assert.deepEqual(current.get(change.type || "BS", change.channel || "C46").streams, []);
        assert.deepEqual(current.get("BS", "C47").streams, streams(2));
    });
}
it("[channel-state-identity] 無効化した行を他行の保存で捨てず、再有効化で復元する", async t => {
    await seed(t);
    _.config.channels[0].isDisabled = true; _.configIntegrity.channels = "disabled";
    const disabled = store(t); await disabled.load();
    assert.equal(disabled.get("BS", "C46"), null);
    assert.deepEqual(disabled.get("BS", "C47").streams, streams(2));
    disabled.get("BS", "C47").setStreams(streams(3)); await save(disabled);
    const saved = await db.loadChannels("disabled");
    assert.deepEqual(saved.find(row => row.channel === "C46").streams, streams(1));
    _.config.channels[0].isDisabled = false; _.configIntegrity.channels = "enabled";
    const enabled = store(t); await enabled.load();
    assert.deepEqual(enabled.get("BS", "C46").streams, streams(1));
    assert.deepEqual(enabled.get("BS", "C47").streams, streams(3));
});
for (const unspecified of [0, null, ""]) {
    it(`[channel-state-identity] 旧未指定値と変数の順序だけの変更は同じ入力として復元する (${JSON.stringify(unspecified)})`, async t => {
        _.config.channels[0].commandVars = { a: 1, b: "2" };
        await seed(t);
        _.config.channels[0].tsmfRelTs = unspecified;
        _.config.channels[0].commandVars = { b: "2", a: 1 }; _.configIntegrity.channels = "after";
        const current = store(t); await current.load();
        assert.deepEqual(current.get("BS", "C46").streams, streams(1));
    });
}
it("[channel-state-identity] 省略した既定routeと明示routeを同じ入力として復元する", async t => {
    _.config.channels[0].route = "SAT"; await seed(t);
    delete _.config.channels[0].route; _.configIntegrity.channels = "after";
    const current = store(t); await current.load();
    assert.deepEqual(current.get("BS", "C46").streams, streams(1));
});
it("[channel-state-identity] 同じintegrityでも明示的に異なる受信入力を取り込まない", async t => {
    await seed(t); _.config.channels[0].route = "SAT";
    const current = store(t); await current.load();
    assert.deepEqual(current.get("BS", "C46").streams, []);
    assert.deepEqual(current.get("BS", "C47").streams, streams(2));
});
it("[channel-state-identity] 明示的なsetStreams([])を古い保存済み経路で復活させない", async t => {
    await seed(t); _.configIntegrity.channels = "after";
    const current = store(t); await current.load();
    current.get("BS", "C46").setStreams([]); await save(current);
    const restored = store(t); await restored.load();
    assert.deepEqual(restored.get("BS", "C46").streams, []);
    assert.deepEqual(restored.get("BS", "C47").streams, streams(2));
});
it("[channel-state-identity] 同名で有効経路を切り替えても別入力の保存済み経路を混ぜない", async t => {
    await seed(t);
    _.config.channels[0].isDisabled = true;
    _.config.channels.push({ name: "sat", type: "BS", channel: "C46", route: "SAT" });
    _.configIntegrity.channels = "sat";
    const sat = store(t); await sat.load();
    assert.equal(sat.get("BS", "C46").route, "SAT"); assert.deepEqual(sat.get("BS", "C46").streams, []);
    sat.get("BS", "C46").setStreams(streams(4)); await save(sat);
    _.config.channels[0].isDisabled = false; _.config.channels[2].isDisabled = true; _.configIntegrity.channels = "catv";
    const catv = store(t); await catv.load();
    assert.equal(catv.get("BS", "C46").route, "CATV"); assert.deepEqual(catv.get("BS", "C46").streams, streams(1));
});
it("[channel-state-identity] 旧形式の経路はintegrity一致時だけ読み込み、変更後は推測しない", async t => {
    await writeRecords([{ type: "BS", channel: "C46", streams: streams(1) }]);
    const compatible = store(t); await compatible.load();
    assert.deepEqual(compatible.get("BS", "C46").streams, streams(1));
    assert.deepEqual((await db.loadChannels("before"))[0].reception, { route: "CATV", commandVars: {} });
    await writeRecords([{ type: "BS", channel: "C46", streams: streams(1) }]);
    _.configIntegrity.channels = "after";
    const incompatible = store(t); await incompatible.load();
    assert.deepEqual(incompatible.get("BS", "C46").streams, []);
});
if (!feature) {
    it("[channel-state-identity] 新形式のJSON移行元はintegrity変更後も入力を照合し、元ファイルを保持する", async t => {
        const records = [{ type: "BS", channel: "C46", reception: { route: "CATV", commandVars: {} }, streams: streams(1) }];
        const original = JSON.stringify([{ __integrity__: "before" }, ...records]);
        await fs.writeFile(process.env.CHANNELS_DB_PATH, original); _.configIntegrity.channels = "after";
        const current = store(t); await current.load();
        assert.deepEqual(current.get("BS", "C46").streams, streams(1));
        assert.equal(await fs.readFile(process.env.CHANNELS_DB_PATH, "utf8"), original);
        const saved = await ChannelStateModel.findOne({ id: "channels" }).lean().exec();
        assert.equal(saved.integrity, "after"); assert.deepEqual(saved.channels, records);
    });
}

if (feature) {
    process.env.SERVICES_DB_PATH = path.join(temporary, "services.json");
    const Service = require(prefix + "/Service").default;
    const ServiceItem = require(prefix + "/ServiceItem").default;
    const Event = require(prefix + "/Event").default;
    function servicesStore(t) {
        const current = new Service(); _.service = current;
        t.after(() => clearTimeout(current._saveTimerId));
        return current;
    }
    async function saveServices(current) {
        current._save(); await db.loadServices(_.configIntegrity.channels); clearTimeout(current._saveTimerId);
    }
    async function serviceSeed(t) {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        await fs.rm(process.env.SERVICES_DB_PATH, { force: true });
        _.event = new Event();
        const jobs = []; _.job = { add: job => jobs.push(job), addSchedule() {}, jobs: [] };
        await seed(t);
        const current = servicesStore(t);
        for (let index = 0; index < 2; ++index) {
            current.add(new ServiceItem(_.channel.items[index], 11, 101 + index, `service ${index}`, 1, -1, undefined, true, 1234, 45001 + index, true));
        }
        await saveServices(current); jobs.length = 0;
        return { current, jobs };
    }
    it("[channel-state-identity] 旧サービスの受信入力も複数候補の無効行から推測せず保持する", async t => {
        await serviceSeed(t);
        const legacy = (await db.loadServices("before")).map(({ reception, ...row }) => ({ ...row, channel: { ...row.channel, route: undefined } }));
        await db.saveServices(legacy, "before"); await db.loadServices("before");
        _.config.channels[0].isDisabled = true;
        _.config.channels.push({ name: "other input", type: "BS", channel: "C46", route: "SAT", isDisabled: true });
        const channels = store(t); await channels.load();
        const current = servicesStore(t); await current.load(); await saveServices(current);
        assert.equal(current.get(11, 101), null);
        const retained = (await db.loadServices("before")).find(item => item.serviceId === 101);
        assert.ok(retained); assert.equal(retained.reception, undefined, "Channelを未証明で保持した後、Serviceから先頭行の設定を認定しません");
        assert.equal(retained.epgReady, true); assert.equal(retained.epgUpdatedAt, 1234); assert.equal(retained.streamId, 45001);
    });
    it("[channel-state-identity] 旧JSONでも名前変更・対象外設定変更で既知サービス全件を捨てず再スキャンしない", async t => {
        const { jobs } = await serviceSeed(t);
        _.config.channels[0].name = "renamed"; _.config.channels.push({ name: "new", type: "GR", channel: "27", isDisabled: true });
        _.configIntegrity.channels = "after";
        const channels = store(t); await channels.load();
        const current = servicesStore(t); await current.load();
        assert.equal(current.items.length, 2);
        assert.equal(current.get(11, 101).epgReady, true);
        assert.equal(current.get(11, 101).epgUpdatedAt, 1234);
        assert.equal(current.get(11, 101).streamId, 45001);
        await current._initJobs();
        const finder = jobs.find(job => job.key === "Service.Add.Scan.Find-Channels"); assert.ok(finder); await finder.fn();
        assert.equal(jobs.filter(job => job.key.startsWith("Service.Update.Scan.") || job.key.startsWith("Service.Add.Scan.") && job !== finder).length, 0);
        const dto = current.items[0].export();
        assert.equal("reception" in dto, false); assert.equal("sourceChannel" in dto, false);
        assert.equal("commandVars" in dto.channel, false);
    });
    it("[channel-state-identity] 無効入力のサービスはAPIに復活させず、他行保存後の同入力再有効化でだけ戻す", async t => {
        await serviceSeed(t); _.config.channels[0].isDisabled = true; _.configIntegrity.channels = "disabled";
        const disabledChannels = store(t); await disabledChannels.load();
        const disabled = servicesStore(t); await disabled.load();
        assert.equal(disabled.get(11, 101), null); assert.equal(disabled.items.length, 1);
        await saveServices(disabled);
        const saved = await db.loadServices("disabled"); assert.equal(saved.length, 2);
        _.config.channels[0].isDisabled = false; _.configIntegrity.channels = "enabled";
        const enabledChannels = store(t); await enabledChannels.load();
        const enabled = servicesStore(t); await enabled.load();
        assert.equal(enabled.items.length, 2); assert.equal(enabled.get(11, 101).streamId, 45001);
    });
    for (const change of [{ route: "SAT" }, { tsmfRelTs: 3 }, { format: "tlv" }, { tsmfGroupId: 2 }, { commandVars: { satellite: 1 } }, null]) {
        it(`[channel-state-identity] 受信入力変更・削除のサービスだけを外し無関係のサービスを保持する (${JSON.stringify(change)})`, async t => {
            await serviceSeed(t);
            if (change) { Object.assign(_.config.channels[0], change); } else { _.config.channels.shift(); }
            _.configIntegrity.channels = "after";
            const channels = store(t); await channels.load();
            const current = servicesStore(t); await current.load();
            assert.equal(current.get(11, 101), null); assert.equal(current.items.length, 1);
            assert.equal(current.get(11, 102).streamId, 45002);
            await saveServices(current); assert.equal((await db.loadServices("after")).length, 1);
        });
    }
    for (const integrity of ["before", "after"]) {
        it(`[channel-state-identity] 旧サービスJSONの受信設定はintegrity ${integrity}で推測しない`, async t => {
            t.mock.timers.enable({ apis: ["setTimeout"] });
            _.event = new Event(); _.job = { add() {}, addSchedule() {}, jobs: [] };
            const channels = store(t);
            await db.saveServices([{ id: 1100101, networkId: 11, serviceId: 101, name: "legacy", type: 1, channel: { type: "BS", channel: "C46" }, streamId: 45001 }], "before");
            await db.loadServices("before"); _.configIntegrity.channels = integrity;
            const current = servicesStore(t); await current.load();
            assert.equal(current.items.length, integrity === "before" ? 1 : 0);
        });
    }
}

it("[channel-state-identity] 旧経路は受信更新なしでもload完了時に受信設定を補完し、次の名前変更へ備える", async t => {
    await writeRecords([{ type: "BS", channel: "C46", streams: streams(1) }]);
    const compatible = store(t); await compatible.load();
    const records = await db.loadChannels("before");
    assert.deepEqual(records[0].reception, { route: "CATV", commandVars: {} });
    _.config.channels[0].name = "renamed"; _.configIntegrity.channels = "after";
    const next = store(t); await next.load();
    assert.deepEqual(next.get("BS", "C46").streams, streams(1));
});

for (const sync of [false, true]) {
    it(`[channel-legacy-integrity] 証明のない旧経路を確定せず、整合性ヘッダーの復元後に読み直せる (sync=${sync})`, async t => {
        const records = [{ type: "BS", channel: "C46", streams: streams(1) }];
        const original = JSON.stringify(records);
        await fs.writeFile(process.env.CHANNELS_DB_PATH, original);
        const warnings = t.mock.method(require(logPath), "warn", () => {});
        assert.deepEqual(await db.loadChannels("before", sync), []);
        assert.equal(warnings.mock.callCount(), 1);
        assert.match(warnings.mock.calls[0].arguments.join(" "), /integrity|整合性/);
        if (!feature) { assert.equal(await ChannelStateModel.countDocuments({ id: "channels" }), 0); }
        assert.equal(await fs.readFile(process.env.CHANNELS_DB_PATH, "utf8"), original);
        await fs.writeFile(process.env.CHANNELS_DB_PATH, JSON.stringify([{ __integrity__: "before" }, ...records]));
        assert.deepEqual(await db.loadChannels("before", sync), records);
        if (!feature) {
            const persisted = await ChannelStateModel.findOne({ id: "channels" }).lean().exec();
            assert.equal(persisted.integrity, "before"); assert.deepEqual(persisted.channels, records);
        }
    });
    it(`[channel-legacy-integrity] ヘッダーなしの新形式も受信設定を照合し、証明のない混在行を使わない (sync=${sync})`, async t => {
        const records = [
            { type: "BS", channel: "C46", streams: streams(9) },
            { type: "BS", channel: "C46", reception: { route: "CATV", commandVars: {} }, streams: streams(1) },
            { type: "BS", channel: "C47", reception: { route: "SAT", commandVars: {} }, streams: streams(2) },
            { type: "BS", channel: "C47", reception: null, streams: streams(3) },
            { type: "BS", channel: "C47", reception: 1, streams: streams(4) },
            { type: "BS", channel: "C47", reception: [], streams: streams(5) },
            { type: "unknown", channel: "C47", reception: { route: "CATV", commandVars: {} }, streams: streams(6) }
        ];
        const original = JSON.stringify(records);
        await fs.writeFile(process.env.CHANNELS_DB_PATH, original);
        assert.deepEqual(await db.loadChannels("before", sync), records.slice(1));
        const current = store(t); await current.load();
        assert.deepEqual(current.get("BS", "C46").streams, streams(1));
        assert.deepEqual(current.get("BS", "C47").streams, [], "同じtype/channelでも保存時の受信経路が違う行を取り込みません");
        assert.equal(await fs.readFile(process.env.CHANNELS_DB_PATH, "utf8"), original);
    });
}
if (feature) {
    it("[channel-legacy-integrity] サービスJSONのヘッダーなし互換はチャンネル限定の検査で変えない", async () => {
        const records = [{ id: 1100101, networkId: 11, serviceId: 101, name: "legacy", type: 1, channel: { type: "BS", channel: "C46" } }];
        await fs.writeFile(process.env.SERVICES_DB_PATH, JSON.stringify(records));
        assert.deepEqual(await db.loadServices("before"), records);
    });
}

for (const unavailable of ["disabled", "no-tuner"]) {
    it(`[channel-state-identity] 旧形式で入力が曖昧な${unavailable}行へ先頭設定を認定せず保持する`, async t => {
        _.config.channels[0].isDisabled = true;
        _.config.channels.push({ name: "same channel on satellite", type: "BS", channel: "C46", route: "SAT", isDisabled: unavailable === "disabled" });
        if (unavailable === "no-tuner") { _.tuner.typeExists = () => false; }
        const record = { type: "BS", channel: "C46", streams: streams(1) };
        await writeRecords([record]);
        const current = store(t); await current.load();
        assert.equal(current.get("BS", "C46"), null);
        if (!feature) { assert.equal(current.getStoredReception({ type: "BS", channel: "C46" }, 11, 45001), undefined); }
        await save(current);
        assert.deepEqual(await db.loadChannels("before"), [record], "受信入力を特定できない旧データを勝手なreception付きに置き換えません");
        _.config.channels[0].isDisabled = false; _.config.channels[2].isDisabled = true;
        _.configIntegrity.channels = "enabled"; _.tuner.typeExists = () => true;
        const enabled = store(t); await enabled.load();
        assert.deepEqual(enabled.get("BS", "C46").streams, [], "入力不明の経路を再有効化先の受信証拠にしません");
    });
}
it("[channel-state-identity] 旧形式でも同じ受信設定の複数行なら無効中に移行し復元する", async t => {
    _.config.channels[0].isDisabled = true;
    _.config.channels.push({ name: "another service on cable", type: "BS", channel: "C46", route: "CATV", serviceId: 101, isDisabled: true });
    await writeRecords([{ type: "BS", channel: "C46", streams: streams(1) }]);
    const current = store(t); await current.load();
    assert.equal(current.get("BS", "C46"), null);
    assert.deepEqual((await db.loadChannels("before"))[0].reception, { route: "CATV", commandVars: {} });
    _.config.channels[0].isDisabled = false; _.configIntegrity.channels = "enabled";
    const enabled = store(t); await enabled.load();
    assert.deepEqual(enabled.get("BS", "C46").streams, streams(1));
});
