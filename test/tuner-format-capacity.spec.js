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
require("reflect-metadata");
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const prefix = fs.existsSync(path.join(__dirname, "../lib/server/modules/Tuner.js")) ? "server/modules" : "Mirakurun";
const statusPath = require.resolve(`../lib/${prefix}/status`);
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0, decoderRespawn: 0 }
} } };
const _ = require(`../lib/${prefix}/_`).default;
const { Tuner } = require(`../lib/${prefix}/Tuner`);
const ChannelItem = require(`../lib/${prefix}/ChannelItem`).default;
function fixture(t, devices) {
    const saved = { channel: _.channel, config: _.config };
    _.channel = { getStreams: () => [] };
    _.config = { server: { defaultTlvStreamFormat: "tlv" }, tuners: [] };
    t.after(() => { _.channel = saved.channel; _.config = saved.config; });
    const tuner = Object.create(Tuner.prototype);
    tuner._devices = devices;
    const terrestrial = new ChannelItem({ type: "GR", channel: "27", route: "TER", format: "ts" });
    const satellite = new ChannelItem({ type: "BS4K", channel: "BS01_0", route: "SAT", format: "tlv" });
    return { tuner, targets: [{ channel: terrestrial }, { channel: satellite }] };
}
function device(type, route, options = {}) {
    return { config: { types: [type], routes: [route], ...options }, isRemote: false,
        get isFree() { throw new Error("形式の判定では現在の空き状態を参照しません"); },
        get isAvailable() { throw new Error("形式の判定では一時的な稼働状態を参照しません"); } };
}
it("[tuner-format-capacity] TS経路に対応デバイスがなくTLV変換もなければ、混在する経路でもTS形式を選ばない", t => {
    const f = fixture(t, [device("BS4K", "SAT")]);
    assert.equal(f.tuner.getOutputFormat(f.targets, "ts"), null);
    assert.equal(f.tuner.getOutputFormat(f.targets, "tlv"), "tlv");
});
it("[tuner-format-capacity] 放送種別が同じでも受信経路が異なるデバイスはTSの能力に数えない", t => {
    const f = fixture(t, [device("GR", "CATV"), device("BS4K", "SAT")]);
    assert.equal(f.tuner.getOutputFormat(f.targets, "ts"), null);
});
it("[tuner-format-capacity] TS経路に対応するデバイスは現在占有中でも形式の能力として扱う", t => {
    const f = fixture(t, [device("GR", "TER"), device("BS4K", "SAT")]);
    assert.equal(f.tuner.getOutputFormat(f.targets, "ts"), "ts");
});
it("[tuner-format-capacity] TS経路のデバイスがなくてもTLVを変換する能力があればTSを選べる", t => {
    const f = fixture(t, [device("BS4K", "SAT", { tlvToTsDecoder: "convert-tlv" })]);
    assert.equal(f.tuner.getOutputFormat(f.targets, "ts"), "ts");
});
it("[tuner-format-capacity] TSだけの経路ではチューナー未接続を形式不一致とみなさない", t => {
    const f = fixture(t, []);
    assert.equal(f.tuner.getOutputFormat([f.targets[0]], "ts"), "ts");
});

it("[tuner-format-capacity] TLVだけの経路にデバイスがなければTS要求も形式不一致とみなさない", t => {
    const f = fixture(t, []);
    assert.equal(f.tuner.getOutputFormat([f.targets[1]], "ts"), "ts");
    assert.equal(f.tuner.getOutputFormat([f.targets[1]], "tlv"), "tlv");
    _.config.server.defaultTlvStreamFormat = "ts";
    assert.equal(f.tuner.getOutputFormat([f.targets[1]]), "ts");
});
it("[tuner-format-capacity] TSとTLVの全経路にデバイスがなければ確保側でチューナー不足を判定する", t => {
    const f = fixture(t, []);
    assert.equal(f.tuner.getOutputFormat(f.targets, "ts"), "ts");
});
it("[tuner-format-capacity] 別経路のデバイスしかなければTLVの変換能力不足とは断定しない", t => {
    const f = fixture(t, [device("BS4K", "FTTH", { tlvToTsDecoder: "convert-tlv" })]);
    assert.equal(f.tuner.getOutputFormat([f.targets[1]], "ts"), "ts");
});
it("[tuner-format-capacity] リモートが相対TS候補から一時除外されても形式不一致とみなさない", t => {
    let canReceive = false;
    const remote = { config: { types: ["BS4K"], routes: ["SAT"] }, isRemote: true, canReceiveRemoteRelTs: () => canReceive };
    const f = fixture(t, [remote]);
    _.channel.getStreams = () => [{ relTs: 2, networkId: 11, streamId: 100, format: "tlv" }];
    const targets = [{ channel: f.targets[1].channel, relTs: 2 }];
    assert.equal(f.tuner.getOutputFormat(targets, "ts"), "ts");
    canReceive = true;
    // 実際の入力候補が戻り、変換器がないことを確認できる場合は406の判定を維持する。
    assert.equal(f.tuner.getOutputFormat(targets, "ts"), null);
});
it("[tuner-format-capacity] 検出済みTLVのチューナーがなければTS配信はJSON503を返す", async t => {
    const f = fixture(t, []);
    const previousTuner = _.tuner;
    t.after(() => { _.tuner = previousTuner; });
    _.tuner = f.tuner;
    _.channel.getStreams = () => [{ relTs: 2, networkId: 11, streamId: 100, format: "tlv" }];
    const targets = [{ channel: f.targets[1].channel, relTs: 2 }];
    const app = require("express")();
    if (prefix === "server/modules") {
        // HTTPのエラー変換だけを検証し、警告のDB保存タイマーを起動しない。
        const event = require("../lib/server/modules/event-log");
        for (const level of ["info", "warn", "error", "debug"]) { t.mock.method(event, level, () => undefined); }
        const { startHTTPStream } = require("../lib/server/modules/http-stream");
        app.get("/stream", (req, res, next) => startHTTPStream(req, res,
            (user, signal, output) => f.tuner.initChannelStream(targets[0].channel, user, output, signal, 2),
            undefined, targets).catch(next));
    } else {
        const { responseStream } = require("../lib/Mirakurun/api");
        app.get("/stream", (req, res) => responseStream(req, res, targets,
            user => f.tuner.initChannelStream(targets[0].channel, user, res, 2)));
    }
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await new Promise(resolve => server.once("listening", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/stream?format=ts`);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal((await response.json()).code, 503);
});
