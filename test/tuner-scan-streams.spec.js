/*
   Copyright 2026 The Mirakurun Developers.

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
const { it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: { epg: {}, epgByStream: {}, streamCount: {}, errorCount: {} } } };
const _ = require("../lib/Mirakurun/_").default;
const { Tuner } = require("../lib/Mirakurun/Tuner");
const log = require("../lib/Mirakurun/log");

function fixture(t, bonded = true) {
    for (const level of ["info", "warn", "error", "debug"]) { t.mock.method(log, level, () => {}); }
    const previous = { channel: _.channel, service: _.service };
    t.after(() => Object.assign(_, previous));
    const saved = [{ networkId: 11, streamId: 77, format: "ts", relTs: 2, slots: 28,
        ...(bonded ? { groupId: 1, numberOfCarriers: 2, carrierSequence: 0, tsmfNetworkId: 4, tsmfStreamId: 99 } : { remote: true }) }];
    const writes = [];
    const channel = { type: "BS4K", channel: "C21", streams: saved,
        getStreamByRelTs(relTs) { return this.streams.find(stream => stream.relTs === relTs); },
        setStreams(streams) { this.streams = streams; writes.push(structuredClone(streams)); },
        getBondedChannels() { return [this]; }, hasAllCarriers: () => true };
    _.channel = { get: () => channel }; _.service = { queueDiscoveredTsmfScan() {} };
    const tuner = Object.create(Tuner.prototype);
    t.mock.method(tuner, "canReceiveTsmfCarriers", () => true);
    const detected = [{ networkId: 4, streamId: 99, format: "tlv", relTs: 2, slots: 30,
        ...(bonded ? { groupId: 1, numberOfCarriers: 2, carrierSequence: 0 } : {}) }];
    const user = { id: "scan", priority: -1, streamSetting: { channel } };
    return { tuner, channel, saved, writes, detected, user };
}
for (const bonded of [true, false]) {
    it(`[tuner-scan-streams.spec] ${bonded ? "bonded" : "remote-to-local"}全失敗では暫定形式を保存済みのidentityへ戻す`, async t => {
        const f = fixture(t, bonded), error = new Error("scan failed");
        t.mock.method(f.tuner, "_scanServices", async () => { throw error; });
        await assert.rejects(f.tuner._scanTSMFServices(f.channel, f.user, f.detected), cause => cause === error);
        assert.ok(f.writes.length >= 2, "暫定経路と確定失敗時の復旧経路を書き込む");
        assert.equal(f.channel.streams[0].networkId, 11);
        assert.equal(f.channel.streams[0].streamId, 77);
        assert.equal(f.channel.streams[0].format, "ts");
    });
}
it("[tuner-scan-streams.spec] 暫定登録直後の異常は元の配列へ戻す", async t => {
    const f = fixture(t), error = new Error("carrier validation failed");
    f.channel.hasAllCarriers = () => { throw error; };
    await assert.rejects(f.tuner._scanTSMFServices(f.channel, f.user, f.detected), cause => cause === error);
    assert.equal(f.channel.streams, f.saved);
});
it("[tuner-scan-streams.spec] 別の更新が置いた配列を失敗スキャンの復旧で上書きしない", async t => {
    const f = fixture(t), error = new Error("scan failed"), replacement = [{ networkId: 55, streamId: 66, format: "ts", relTs: 3 }];
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
    t.mock.method(f.tuner, "_scanServices", async () => { enter(); await gate; throw error; });
    const scanning = f.tuner._scanTSMFServices(f.channel, f.user, f.detected);
    const rejected = assert.rejects(scanning, cause => cause === error);
    await entered; f.channel.setStreams(replacement); release(); await rejected;
    assert.equal(f.channel.streams, replacement);
});
