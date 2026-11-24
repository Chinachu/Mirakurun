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
const fs = require("node:fs");
const path = require("node:path");
const feature = fs.existsSync(path.join(__dirname, "../src/Mirakurun"));
const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
const statusPath = require.resolve(prefix + "/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: {}
} } };
const logPath = require.resolve(prefix + (feature ? "/log" : "/event-log"));
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require(prefix + "/_").default;
const TunerDevice = require(prefix + "/TunerDevice").default;
const Event = require(prefix + "/Event").default;
function fixture(t) {
    const previous = _.config; _.config = { server: {} };
    t.mock.method(Event, "emit", () => {});
    t.after(() => { _.config = previous; });
    const device = new TunerDevice(0, { name: "relative cache", types: ["BS"], remoteMirakurunHost: "fixture.invalid" });
    device._remoteRelTsSupported = true;
    t.after(async () => {
        if (device.close) { await device.close(); }
        else { device._clearEndStreamTimer(); clearTimeout(device._remoteRelTsRetryTimer); }
    });
    return device;
}
const channel = channel => ({ type: "BS", channel });
const key = (channel, relTs = 2) => `BS/${channel}/${relTs}`;
it("[tuner-relative-cache] 有効な拒否を保持し、10分の期限になったキーを読取時に除去する", t => {
    const device = fixture(t), target = channel("C19");
    let now = 1000000;
    t.mock.method(Date, "now", () => now);
    device._remoteRelTsRefused.set(key("C19"), now);
    now += 599999;
    assert.equal(device.canReceiveRemoteRelTs(target, 2), false);
    assert.equal(device._remoteRelTsRefused.has(key("C19")), true);
    assert.equal(device.canReceiveRemoteRelTs(channel("C20"), 2), true, "別の未検出入力は拒否しません");
    ++now;
    assert.equal(device.canReceiveRemoteRelTs(target, 2), true);
    assert.equal(device._remoteRelTsRefused.has(key("C19")), false);
});
it("[tuner-relative-cache] 確認済みの1分期限を過ぎたら再照会対象へ戻し、読取時にキーを除去する", t => {
    const device = fixture(t), target = channel("C19");
    let now = 1000000;
    t.mock.method(Date, "now", () => now);
    device._remoteChannelRelTsCheckedAt.set(key("C19"), now);
    now += 59999;
    assert.equal(device.isRemoteChannelRelTsChecked(target, 2), true);
    assert.equal(device._remoteChannelRelTsCheckedAt.has(key("C19")), true);
    ++now;
    assert.equal(device.isRemoteChannelRelTsChecked(target, 2), false);
    assert.equal(device._remoteChannelRelTsCheckedAt.has(key("C19")), false);
});
it("[tuner-relative-cache] 照会結果の更新で期限切れだけを掃除し、有効な別キーを保持する", async t => {
    const device = fixture(t), now = 1000000;
    t.mock.method(Date, "now", () => now);
    device._remoteRelTsRefused.set(key("expired"), now - 600000);
    device._remoteRelTsRefused.set(key("active"), now - 1);
    device._remoteChannelRelTsCheckedAt.set(key("expired"), now - 60000);
    device._remoteChannelRelTsCheckedAt.set(key("active"), now - 1);
    assert.equal(await device.checkRemoteChannelRelTs(channel("new"), 2, undefined, async () => ({ tsmfRelTs: 2 })), true);
    assert.deepEqual([...device._remoteRelTsRefused.keys()], [key("active")]);
    assert.deepEqual([...device._remoteChannelRelTsCheckedAt.keys()], [key("active"), key("new")]);
    assert.equal(device.canReceiveRemoteRelTs(channel("active"), 2), false);
});
it("[tuner-relative-cache] 相対TS未検出の拒否と、別入力の新しい照会をそれぞれ保持する", async t => {
    const device = fixture(t);
    let now = 1000000;
    t.mock.method(Date, "now", () => now);
    assert.equal(await device.checkRemoteChannelRelTs(channel("C19"), 2, undefined, async () => ({ services: [{ serviceId: 101 }] })), false);
    assert.equal(device.canReceiveRemoteRelTs(channel("C19"), 2), false);
    now += 1000;
    assert.equal(await device.checkRemoteChannelRelTs(channel("C20"), 2, undefined, async () => ({ services: [] })), true);
    assert.equal(device.canReceiveRemoteRelTs(channel("C20"), 2), true);
    assert.equal(device.canReceiveRemoteRelTs(channel("C19"), 2), false);
    device.clearRemoteRelTsRefused(channel("C19"), 2);
    assert.equal(device.canReceiveRemoteRelTs(channel("C19"), 2), true);
});
it("[tuner-relative-cache] 照会失敗の更新でも期限切れキーを掃除し、有効な拒否は残す", async t => {
    const device = fixture(t), now = 1000000;
    t.mock.method(Date, "now", () => now);
    device._remoteRelTsRefused.set(key("expired"), now - 600000);
    device._remoteRelTsRefused.set(key("active"), now - 1);
    device._remoteChannelRelTsCheckedAt.set(key("expired"), now - 60000);
    const failure = new Error("lookup unavailable");
    assert.equal(await device.checkRemoteChannelRelTs(channel("new"), 2, undefined, async () => { throw failure; }), false);
    assert.deepEqual([...device._remoteRelTsRefused.keys()], [key("active")]);
    assert.equal(device._remoteChannelRelTsCheckedAt.size, 0);
    assert.equal(device.getRemoteChannelRelTsCheckError(channel("new"), 2), failure);
});
it("[tuner-relative-cache] 照会待ちで中止された要求の結果を確認済みとして残さない", async t => {
    const device = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
    const controller = new AbortController(), reason = new Error("lookup aborted");
    const pending = device.checkRemoteChannelRelTs(channel("pending"), 2, controller.signal, async () => { entered.resolve(); await release.promise; return { services: [] }; });
    const settled = assert.rejects(pending, error => error === reason);
    t.after(async () => { release.resolve(); await settled.catch(() => {}); });
    await entered.promise;
    controller.abort(reason); release.resolve(); await settled;
    assert.equal(device._remoteRelTsRefused.size, 0);
    assert.equal(device._remoteChannelRelTsCheckedAt.size, 0);
});
it("[tuner-relative-cache] 64件を超える有効な拒否も期限内は保持し、期限後の更新で解放する", async t => {
    const device = fixture(t);
    let now = 1000000;
    t.mock.method(Date, "now", () => now);
    for (let i = 0; i < 70; ++i) {
        assert.equal(await device.checkRemoteChannelRelTs(channel(`C${i}`), 2, undefined, async () => ({ services: [{ serviceId: 101 }] })), false);
    }
    assert.equal(device._remoteRelTsRefused.size, 70, "短期照会失敗の64件上限を有効な拒否へ流用しません");
    for (let i = 0; i < 70; ++i) { assert.equal(device.canReceiveRemoteRelTs(channel(`C${i}`), 2), false); }
    now += 600000;
    assert.equal(await device.checkRemoteChannelRelTs(channel("new"), 2, undefined, async () => ({ services: [] })), true);
    assert.equal(device._remoteRelTsRefused.size, 0);
    assert.deepEqual([...device._remoteChannelRelTsCheckedAt.keys()], [key("new")]);
});
if (!feature) {
    it("[tuner-relative-cache] closeで照会キーを解放し、待機中の結果で復活させない", async t => {
        const device = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
        device._remoteRelTsRefused.set(key("refused"), Date.now());
        device._remoteChannelRelTsCheckedAt.set(key("checked"), Date.now());
        const pending = device.checkRemoteChannelRelTs(channel("pending"), 2, undefined, async () => { entered.resolve(); await release.promise; return { services: [] }; });
        const settled = assert.rejects(pending, error => error === device._remoteRelTsAbort.signal.reason);
        t.after(async () => { release.resolve(); await settled.catch(() => {}); });
        await entered.promise;
        await device.close();
        assert.equal(device._remoteRelTsRefused.size, 0);
        assert.equal(device._remoteChannelRelTsCheckedAt.size, 0);
        release.resolve(); await settled;
        assert.equal(device._remoteRelTsRefused.size, 0);
        assert.equal(device._remoteChannelRelTsCheckedAt.size, 0);
    });
}

for (const staleFailure of [false, true]) {
    for (const currentFailure of [false, true]) {
        it(`[raw-capability-generation] 拒否後に合流した要求は旧照会を待って現世代を共有照会する (oldFailure=${staleFailure}, currentFailure=${currentFailure})`, { timeout: 5000 }, async t => {
            const { EventEmitter, once } = require("node:events");
            const { PassThrough } = require("node:stream");
            const childProcess = require("node:child_process");
            const device = fixture(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
            const staleError = new Error("stale capability failure"), currentError = new Error("current capability failure");
            const log = require(logPath), warn = t.mock.method(log, "warn", () => {});
            let inFlight = 0, maxInFlight = 0, calls = 0;
            t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
                ++inFlight; maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    if (++calls === 1) {
                        entered.resolve(); await gate.promise;
                        if (staleFailure) { throw staleError; }
                    } else if (currentFailure) { throw currentError; }
                    return true;
                } finally { --inFlight; }
            } }));
            const process = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill: t.mock.fn() });
            t.mock.method(childProcess, "spawn", () => process);
            await device._spawnCommand({ type: "BS", channel: "C19", route: "SAT" }, undefined, "ts", true);
            device._remoteRawTsmfSupport = { supported: true, expiresAt: Date.now() - 1 };
            const reported = [[], [], []];
            const report = index => error => { reported[index].push(error); return true; };
            const first = device.checkRemoteRawTsmf(undefined, report(0));
            t.after(async () => { gate.resolve(); await first; process.stdout.destroy(); process.stderr.destroy(); });
            await entered.promise;
            const generation = device._remoteRawTsmfGeneration;
            const released = once(device, "release");
            process.emit("exit", 2, null); process.emit("close", 2, null);
            await released;
            assert.equal(device._remoteRawTsmfGeneration, generation + 1, "生TSMF拒否の終了経路で旧照会を失効させます");
            assert.equal(device.supportsRemoteRawTsmf, undefined);
            const joined = [device.checkRemoteRawTsmf(undefined, report(1)), device.checkRemoteRawTsmf(undefined, report(2))];
            assert.equal(calls, 1, "旧照会を並行実行したまま新しい照会を開始しません");
            gate.resolve();
            assert.deepEqual(await Promise.all([first, ...joined]), [false, !currentFailure, !currentFailure]);
            assert.equal(calls, 2, "拒否後の要求は現世代の照会を1回だけ共有します");
            assert.equal(maxInFlight, 1);
            assert.equal(device._remoteRawTsmfChecking, null);
            assert.equal(device.supportsRemoteRawTsmf, !currentFailure);
            assert.equal(device.remoteRawTsmfCheckError, currentFailure ? currentError : undefined);
            assert.deepEqual(reported, currentFailure ? [[], [currentError], [currentError]] : [[], [], []]);
            const warnings = warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("生TSMF対応を確認できませんでした")));
            assert.equal(warnings.length, currentFailure ? 1 : 0, "現世代の障害だけを一度警告します");
            assert.equal(await device.checkRemoteRawTsmf(), !currentFailure);
            assert.equal(calls, 2, "有効な現世代の結果はキャッシュします");
        });
    }
}
