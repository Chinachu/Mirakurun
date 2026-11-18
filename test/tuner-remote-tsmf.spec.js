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
const { beforeEach, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const childProcess = require("node:child_process");

// 実タイマーを持つ状態集計だけを隔離し、フィルターとチューナー本体はビルド済み実装を使う。
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0, decoderRespawn: 0, tunerDeviceRespawn: 0 }
} } };
const _ = require("../lib/Mirakurun/_").default;
const eventPath = require.resolve("../lib/Mirakurun/log");
const event = { info() {}, warn() {}, error() {}, debug() {} };
require.cache[eventPath] = { id: eventPath, filename: eventPath, loaded: true, exports: event };
const { Tuner } = require("../lib/Mirakurun/Tuner");
const TunerDevice = require("../lib/Mirakurun/TunerDevice").default;
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
const TSDecoder = require("../lib/Mirakurun/TSDecoder").default;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const setTunerConfig = config => { _.config = config; };

beforeEach(t => {
    setTunerConfig({ server: {}, tuners: [] });
    const originalChannel = _.channel;
    _.channel = { getStreams: () => [], items: [] };
    t.after(() => { _.channel = originalChannel; });
    t.mock.method(require("../lib/Mirakurun/Event").default, "emit", () => {});
    for (const level of ["info", "warn", "error", "debug"]) { t.mock.method(event, level, () => {}); }
});

async function releaseDevice(device) {
    device._clearEndStreamTimer();
    clearTimeout(device._remoteRelTsRetryTimer); device._remoteRelTsRetryTimer = null;
    if (device._process?.pid || device._dvbActive) { await device.kill(); }
    clearTimeout(device._dvbCloseTimer); device._dvbCloseTimer = null;
    if (device._dvb) { await device._dvb.close(); }
}

function fixture(t, configurations) {
    const processes = [], devices = [], filters = [], writes = [];
    t.mock.method(childProcess, "spawn", (command, args, options) => {
        const proc = Object.assign(new EventEmitter(), {
            pid: 3000 + processes.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            command, args, options, closed: false
        });
        proc.kill = () => {
            if (!proc.closed) {
                proc.closed = true;
                queueMicrotask(() => { proc.stderr.end(); proc.emit("exit", 0, null); proc.emit("close", 0, null); });
            }
            return true;
        };
        processes.push(proc);
        return proc;
    });
    for (const [index, config] of configurations.entries()) {
        const device = new TunerDevice(index, { name: `fixture-${index}`, types: ["BS", "BS4K"], disableDvbDirect: true, ...config });
        device._remoteRelTsSupported = true;
        device._remoteRawTsmfSupport = { supported: true, expiresAt: Date.now() + 60000 };
        t.mock.method(device, "getRemoteChannel", async (type, channel) => {
            if (device.remoteChannelError) { throw device.remoteChannelError; }
            return { type, channel, services: [], ...device.remoteChannel };
        });
        devices.push(device);
    }
    const tuner = new Tuner();
    tuner._devices = devices;
    const output = new Writable({ write(chunk, encoding, callback) { writes.push(Buffer.from(chunk)); callback(); } });
    const start = async (channel, relTs, format, { decoder = false } = {}) => {
        const user = { id: `remote-test-${filters.length}`, priority: 0, disableDecoder: !decoder, outputFormat: format,
            streamSetting: { channel } };
        const candidate = tuner._getCandidate(channel, relTs, format);
        const filter = await tuner._initTS(user, output, [candidate]);
        filters.push(filter);
        return { filter, user };
    };
    t.after(async () => {
        for (const filter of filters) { filter.close(false); }
        await Promise.all(devices.map(releaseDevice));
        for (const proc of processes) { proc.stderr.unpipe(); proc.kill(); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
        output.destroy();
    });
    return { tuner, devices, processes, filters, writes, output, start };
}

function channel(format, options = {}) {
    return new ChannelItem({ name: "TSMF", type: format === "tlv" ? "BS4K" : "BS", channel: "C19", route: "CATV",
        tsmfRelTs: 1, format, ...options });
}
function content(format) {
    return Buffer.concat(Array.from({ length: 8 }, (_, index) => {
        const packet = Buffer.alloc(format === "tlv" ? 150 : 188, 0x80 + index);
        if (format === "tlv") { packet[0] = 0x7F; packet[1] = 0xFE; packet.writeUInt16BE(146, 2); }
        else { packet[0] = 0x47; packet[1] = 0x01; packet[2] = 0x00; packet[3] = 0x10 | index; }
        return packet;
    }));
}

for (const format of ["ts", "tlv"]) {
    it(`[tuner-remote-tsmf.spec] 未照会の展開済みremoteへ後続要求を合流させる (${format})`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "first.example" }, { remoteMirakurunHost: "second.example" }]);
        const target = channel(format);
        for (const device of f.devices) { device.remoteChannel = { tsmfRelTs: 1 }; }
        await f.start(target, 1, format);
        await f.start(target, 1, format);
        assert.deepEqual(f.devices.map(device => device.users.length), [2, 0]);
        assert.equal(f.processes.length, 1, "展開済みの同一入力を二重に確保しない");
    });
}

it("[tuner-remote-tsmf.spec] 生TSMF非対応peerを確保せず対応peerを選ぶ", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "old.example" }, { remoteMirakurunHost: "new.example" }]);
    f.devices[0]._remoteRawTsmfSupport = undefined;
    const check = t.mock.method(f.devices[0], "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => false }));
    await f.start(channel("ts"), 1, "ts");
    assert.equal(check.mock.callCount(), 1);
    assert.deepEqual(f.devices.map(device => device.users.length), [0, 1]);
    assert.equal(f.processes.length, 1);
    assert.equal(f.processes[0].args.includes("old.example"), false);
    assert.equal(f.devices[0].supportsRemoteRawTsmf, false);
});

it("[tuner-remote-tsmf.spec] 生TSMF非対応peerは期限後に再確認し更新済みpeerを利用できる", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "upgraded.example" }]);
    const device = f.devices[0];
    device._remoteRawTsmfSupport = undefined;
    let now = Date.now(), supported = false, calls = 0;
    t.mock.method(Date, "now", () => now);
    t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => { calls++; return supported; } }));
    assert.equal(await device.checkRemoteRawTsmf(), false);
    supported = true;
    assert.equal(await device.checkRemoteRawTsmf(), false);
    assert.equal(calls, 1);
    now += 10 * 60 * 1000 + 1;
    assert.equal(await device.checkRemoteRawTsmf(), true);
    assert.equal(calls, 2);
});

it("[tuner-remote-tsmf.spec] 生TSMF対応照会の障害は短期間だけ候補から外す", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "recovering.example" }]);
    const device = f.devices[0];
    device._remoteRawTsmfSupport = undefined;
    let now = Date.now(), calls = 0;
    t.mock.method(Date, "now", () => now);
    t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
        if (++calls === 1) { throw new Error("connection reset"); } return true;
    } }));
    assert.equal(await device.checkRemoteRawTsmf(), false);
    assert.equal(await device.checkRemoteRawTsmf(), false);
    assert.equal(calls, 1);
    now += 10001;
    assert.equal(await device.checkRemoteRawTsmf(), true);
    assert.equal(calls, 2);
});

it("[tuner-remote-tsmf.spec] 生TSMF対応照会は要求の中断を返し障害キャッシュを残さない", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
    const device = f.devices[0];
    device._remoteRawTsmfSupport = undefined;
    const entered = deferred(), response = deferred(), controller = new AbortController();
    t.after(() => response.resolve(true));
    t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }); entered.resolve();
        void response.promise.then(resolve, reject);
    }) }));
    const pending = device.checkRemoteRawTsmf(controller.signal);
    await entered.promise;
    const reason = new Error("cancel raw capability"); controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(device.supportsRemoteRawTsmf, undefined);
    response.resolve(true);
    assert.equal(await device.checkRemoteRawTsmf(), true);
});

it("[tuner-remote-tsmf.spec] 生TSMF対応確認を待ってから一度だけ確保する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
    f.devices[0]._remoteRawTsmfSupport = undefined;
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve(true));
    t.mock.method(f.devices[0], "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async ({ signal }) => {
        assert.ok(signal instanceof AbortSignal);
        entered.resolve(); return release.promise;
    } }));
    const pending = f.start(channel("ts"), 1, "ts");
    await entered.promise;
    assert.equal(f.processes.length, 0);
    assert.equal(f.devices[0].users.length, 0);
    release.resolve(true);
    await pending;
    assert.equal(f.processes.length, 1);
});

it("[tuner-remote-tsmf.spec] 生TSMFでリモート復号だけが設定されていると警告する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example", remoteMirakurunDecoder: true }]);
    await f.start(channel("ts"), 1, "ts", { decoder: true });
    assert.ok(event.warn.mock.calls.some(call => call.arguments.some(value => typeof value === "string" && value.includes("未復号で出力します"))));
});

it("[tuner-remote-tsmf.spec] リモート出力照会の障害をチューナー不足と区別する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
    f.devices[0].remoteChannelError = new Error("metadata network down");
    await assert.rejects(f.start(channel("ts"), 1, "ts"), error => error.code === "ERR_TUNER_UNAVAILABLE" && error.message.includes("出力を確認できません"));
    assert.equal(f.processes.length, 0);
    f.devices[0].remoteChannelError = undefined;
    await f.start(channel("ts"), 1, "ts");
    assert.equal(f.processes.length, 1, "次の取得要求ではリモートを再照会する");
});

for (const format of ["ts", "tlv"]) {
    it(`[tuner-remote-tsmf.spec] リモートで展開済みの設定相対TSを再展開しない (${format})`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
        f.devices[0].remoteChannel = { tsmfRelTs: 1 };
        const { filter } = await f.start(channel(format), 1, format);
        const received = content(format);
        const remote = f.processes.find(proc => proc.args?.[0] === "lib/remote");
        assert.ok(remote, "リモート配信プロセスを起動する");
        remote.stdout.write(received);
        f.devices[0]._flushUsers();
        filter.flush();
        assert.equal(Buffer.concat(f.writes).equals(received), true, "展開済みデータをそのままフィルターへ渡す");
        assert.equal(format === "ts" ? filter._tsmfEnableTsmfSplit : filter._tsmf !== null, false);
    });
}

it("[tuner-remote-tsmf.spec] リモートで相対TSが未設定ならローカル展開を保つ", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
    f.devices[0].remoteChannel = {};
    const { filter } = await f.start(channel("ts"), 1, "ts");
    assert.equal(filter._tsmfEnableTsmfSplit, true);
});

for (const format of ["ts", "tlv"]) {
    it(`[tuner-remote-tsmf.spec] ローカル入力の設定相対TSは分離を維持する (${format})`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ command: "local-tuner" }]);
        const { filter } = await f.start(channel(format), 1, format);
        assert.equal(format === "ts" ? filter._tsmfEnableTsmfSplit : filter._tsmf !== null, true);
    });
}

it("[tuner-remote-tsmf.spec] 検出済み相対TSのremote要求は明示relTsで一度だけ展開する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
    const target = channel("ts", { tsmfRelTs: undefined });
    const { filter, user } = await f.start(target, 2, "ts");
    const remote = f.processes.find(proc => proc.args?.[0] === "lib/remote");
    assert.ok(remote.args.includes("relTs=2"));
    assert.equal(user.streamSetting.tsmfRelTs, 2);
    assert.equal(filter._tsmfEnableTsmfSplit, false);
    const received = content("ts");
    remote.stdout.write(received);
    f.devices[0]._flushUsers();
    filter.flush();
    assert.equal(Buffer.concat(f.writes).equals(received), true);
});

it("[tuner-remote-tsmf.spec] remoteの生TSをTLVへローカル展開する同一チャンネルへ合流できる", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
    const target = channel("tlv");
    await f.start(target, 1, "tlv");
    await f.start(target, 1, "tlv");
    assert.equal(f.devices[0].users.length, 2);
    assert.equal(f.processes.length, 1, "同じ生TSMF入力を二重に確保しない");
    assert.equal(f.devices[0].remoteFormat, "ts");
});

function bondedChannels() {
    const channels = ["C19", "C20"].map(id => channel("tlv", { channel: id, tsmfGroupId: 1 }));
    _.channel.items = channels;
    return channels;
}

it("[tuner-remote-tsmf.spec] 設定相対TSをremote側で結合する場合は一次remoteだけを確保する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
    f.devices[0].remoteChannel = { tsmfRelTs: 1 };
    const channels = bondedChannels();
    const { filter } = await f.start(channels[0], 1, "tlv");
    assert.equal(f.processes.length, 1);
    assert.equal(f.devices[0].users.length, 1);
    assert.equal(filter._bonding, null);
    assert.equal(filter._tsmf, null);
    const received = content("tlv");
    f.processes[0].stdout.write(received);
    f.devices[0]._flushUsers();
    filter.flush();
    assert.equal(Buffer.concat(f.writes).equals(received), true);
});

it("[tuner-remote-tsmf.spec] remote一台の自己結合を形式判定とジョブ準備で落とさない", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
    f.devices[0].remoteChannel = { tsmfRelTs: 1 };
    const channels = bondedChannels();
    assert.equal(f.tuner.getOutputFormat([{ channel: channels[0], relTs: 1 }], "tlv"), "tlv");
    assert.equal(await f.tuner.readyForJob(channels[0]), channels[0]);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[0]]);
    const { filter } = await f.start(channels[0], 1, "tlv");
    assert.equal(filter._bonding, null);
    assert.equal(f.processes.length, 1);
});

for (const primaryRemote of [false, true]) {
    it(`[tuner-remote-tsmf.spec] 生TSMFを返すremote${primaryRemote ? "一次側" : "搬送波"}だけをローカル結合に使う`, { timeout: 5000 }, async t => {
        const local = { command: "local-tuner" }, remote = { remoteMirakurunHost: "remote.example" };
        const f = fixture(t, primaryRemote ? [remote, local] : [local, remote]);
        const channels = bondedChannels();
        const { filter } = await f.start(channels[0], 1, "tlv");
        assert.ok(filter._bonding);
        assert.equal(f.devices[0].users.length, 1);
        assert.equal(f.devices[1].users.length, 1);
        const remoteProcess = f.processes.find(proc => proc.args?.[0] === "lib/remote");
        assert.ok(remoteProcess);
        assert.equal(remoteProcess.args.includes("tlv"), false, "搬送波をTLVへ展開しない");
        assert.equal(remoteProcess.args.includes("ts"), true, "BS4Kでも生TSを明示して取得する");
        assert.equal(remoteProcess.args.some(arg => arg.startsWith("relTs=")), false);
        assert.equal(f.devices.find(device => device.isRemote).remoteFormat, "ts");
    });
}

it("[tuner-remote-tsmf.spec] 生TSMF未対応のremoteを生搬送波に選ばずローカル搬送波を確保する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ command: "local-a" }, { remoteMirakurunHost: "remote.example" }, { command: "local-b" }]);
    f.devices[1].remoteChannel = { tsmfRelTs: 1 };
    f.devices[1]._remoteRawTsmfSupport = { supported: false, expiresAt: Date.now() + 60000 };
    const channels = bondedChannels();
    const { filter } = await f.start(channels[0], 1, "tlv");
    assert.ok(filter._bonding);
    assert.deepEqual(f.devices.map(device => device.users.length), [1, 0, 1]);
    assert.equal(f.processes.some(proc => proc.args?.[0] === "lib/remote"), false);
});

it("[tuner-remote-tsmf.spec] remote既定入力を確認できなければローカル候補へ切り替える", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }, { command: "local-tuner" }]);
    f.devices[0].remoteChannelError = new Error("remote metadata unavailable");
    const { filter } = await f.start(channel("ts"), 1, "ts");
    assert.equal(filter._tsmfEnableTsmfSplit, true);
    assert.deepEqual(f.devices.map(device => device.users.length), [0, 1]);
});

for (const firstRemote of [true, false]) {
    it(`[tuner-remote-tsmf.spec] 同じdecoderでも${firstRemote ? "リモートからローカル" : "ローカルからリモート"}への再選択はフィルターを作り直す`, { timeout: 5000 }, async t => {
        const f = fixture(t, [
            { command: "local-tuner", decoder: "same-decoder", ...(firstRemote && { remoteMirakurunHost: "remote.example" }) },
            { command: "local-tuner", decoder: "same-decoder", ...(!firstRemote && { remoteMirakurunHost: "remote.example" }) }
        ]);
        const target = channel("ts", { tsmfRelTs: undefined });
        const candidate = { channel: target, relTs: 2, format: "ts", devices: f.devices };
        const entered = deferred(), resume = deferred();
        let selection = 0, waits = 0;
        t.mock.method(f.tuner, "_pickTunerDeviceWithCarriers", () => ({
            picked: { device: f.devices[selection], channel: target, candidate }, carriers: []
        }));
        for (const device of f.devices) {
            t.mock.method(device, "isRemoteChannelRelTsChecked", () => true);
        }
        t.mock.method(TSDecoder.prototype, "waitForStart", async () => {
            if (++waits === 1) { entered.resolve(); await resume.promise; }
        });
        t.after(() => resume.resolve());
        const running = f.tuner._initTS({ id: "decoder-reselection", priority: 0, outputFormat: "ts", streamSetting: { channel: target } },
            f.output, [candidate]);
        await entered.promise;
        selection = 1;
        resume.resolve();
        const filter = await running;
        f.filters.push(filter);
        assert.equal(waits, 2, "入力の展開責務が異なるためdecoderとfilterを再作成する");
        assert.equal(filter._tsmfEnableTsmfSplit, firstRemote, "最終デバイスに合わせてTSMF分離を設定する");
        assert.equal(f.devices[0].users.length, 0);
        assert.equal(f.devices[1].users.length, 1);
    });
}

it("[tuner-remote-tsmf.spec] decoder待機後に再選択した検出済みremoteの相対TSを照会してから確保する", { timeout: 5000 }, async t => {
    const f = fixture(t, [
        { remoteMirakurunHost: "first.example", decoder: "same-decoder" },
        { remoteMirakurunHost: "second.example", decoder: "same-decoder" }
    ]);
    const target = channel("ts", { tsmfRelTs: undefined });
    const candidate = { channel: target, relTs: 2, format: "ts", devices: f.devices };
    const decoderEntered = deferred(), decoderResume = deferred();
    const checkEntered = deferred(), checkResume = deferred();
    const checked = new Set([f.devices[0]]);
    let selection = 0, waits = 0;
    t.mock.method(f.tuner, "_pickTunerDeviceWithCarriers", () => ({
        picked: { device: f.devices[selection], channel: target, candidate }, carriers: []
    }));
    for (const device of f.devices) {
        t.mock.method(device, "isRemoteChannelRelTsChecked", () => checked.has(device));
    }
    const request = t.mock.method(f.devices[1], "checkRemoteChannelRelTs", async () => {
        checkEntered.resolve();
        await checkResume.promise;
        checked.add(f.devices[1]);
        return true;
    });
    t.mock.method(TSDecoder.prototype, "waitForStart", async () => {
        if (++waits === 1) { decoderEntered.resolve(); await decoderResume.promise; }
    });
    t.after(() => { decoderResume.resolve(); checkResume.resolve(); });
    const running = f.tuner._initTS({ id: "detected-remote-reselection", priority: 0, outputFormat: "ts", streamSetting: { channel: target } },
        f.output, [candidate]);
    void running.then(filter => f.filters.push(filter), () => {});
    await decoderEntered.promise;
    selection = 1;
    decoderResume.resolve();
    await Promise.race([
        checkEntered.promise,
        running.then(() => { throw new Error("再選択したremoteの相対TSを照会せずに確保しました"); })
    ]);
    assert.equal(request.mock.callCount(), 1);
    assert.deepEqual(f.devices.map(device => device.users.length), [0, 0], "再照会の待機中はチューナーを確保しない");
    checkResume.resolve();
    const filter = await running;
    assert.equal(waits, 2);
    assert.deepEqual(f.devices.map(device => device.users.length), [0, 1]);
    assert.equal(filter._tsmfEnableTsmfSplit, false);
});

for (const firstConfigured of [true, false]) {
    it(`[tuner-remote-tsmf.spec] remote間の再選択も${firstConfigured ? "展開済みから生TSMF" : "生TSMFから展開済み"}ならフィルターを作り直す`, { timeout: 5000 }, async t => {
        const f = fixture(t, [
            { remoteMirakurunHost: "first.example", decoder: "same-decoder" },
            { remoteMirakurunHost: "second.example", decoder: "same-decoder" }
        ]);
        f.devices[0].remoteChannel = firstConfigured ? { tsmfRelTs: 1 } : {};
        f.devices[1].remoteChannel = firstConfigured ? {} : { tsmfRelTs: 1 };
        const target = channel("ts");
        const candidate = { channel: target, relTs: 1, format: "ts", devices: f.devices };
        const entered = deferred(), resume = deferred();
        let selection = 0, waits = 0;
        t.mock.method(f.tuner, "_pickTunerDeviceWithCarriers", () => ({
            picked: { device: f.devices[selection], channel: target, candidate }, carriers: []
        }));
        t.mock.method(TSDecoder.prototype, "waitForStart", async () => {
            if (++waits === 1) { entered.resolve(); await resume.promise; }
        });
        t.after(() => resume.resolve());
        const running = f.tuner._initTS({ id: "remote-decoder-reselection", priority: 0, outputFormat: "ts", streamSetting: { channel: target } },
            f.output, [candidate]);
        await entered.promise;
        selection = 1;
        resume.resolve();
        const filter = await running;
        f.filters.push(filter);
        assert.equal(waits, 2);
        assert.equal(filter._tsmfEnableTsmfSplit, firstConfigured);
        assert.deepEqual(f.devices.map(device => device.users.length), [0, 1]);
    });
}

it("[tuner-remote-tsmf.spec] 生TSMFはリモートで復号せず、TS分離後にローカルで復号する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example", remoteMirakurunDecoder: true, decoder: "local-b25" }]);
    const { filter } = await f.start(channel("ts"), 1, "ts", { decoder: true });
    const remote = f.processes.find(proc => proc.args?.[0] === "lib/remote");
    assert.equal(remote.args.includes("decode"), false, "生TSMFをremote TSDecoderへ渡さない");
    assert.equal(remote.args.includes("rawTsmf=true"), true, "peerへ原本転送を明示する");
    assert.ok(filter._output instanceof TSDecoder, "TSMF分離後はローカルで復号する");
    assert.ok(f.processes.some(proc => proc.command === "local-b25"));
});
it("[tuner-remote-tsmf.spec] 生TSMFからのTLV展開後にローカルで復号する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example", remoteMirakurunDecoder: true, tlvDecoder: "local-tlv" }]);
    const { filter } = await f.start(channel("tlv"), 1, "tlv", { decoder: true });
    assert.ok(filter._output instanceof TSDecoder, "TLV展開後はローカルで復号する");
    const remote = f.processes.find(proc => proc.args?.[0] === "lib/remote");
    assert.equal(remote.args.includes("decode"), false);
    assert.ok(f.processes.some(proc => proc.command === "local-tlv"));
});
it("[tuner-remote-tsmf.spec] 結合前のリモート生搬送波は復号しない", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ command: "local-tuner" }, { remoteMirakurunHost: "remote.example", remoteMirakurunDecoder: true }]);
    const channels = ["C19", "C20"].map(id => channel("tlv", { channel: id, tsmfGroupId: 1 }));
    _.channel.items = channels;
    const { filter } = await f.start(channels[0], 1, "tlv");
    assert.ok(filter._bonding);
    const remote = f.processes.find(proc => proc.args?.[0] === "lib/remote");
    assert.equal(remote.args.includes("decode"), false, "生搬送波をremote TSDecoderへ渡さない");
    assert.equal(remote.args.includes("rawTsmf=true"), true, "結合搬送波もpeerへ原本転送を明示する");
});

it("[tuner-remote-tsmf.spec] 生TSMF入力の再spawnも復号を抑止し、完全解放後は内部フラグを外す", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example", remoteMirakurunDecoder: true }]);
    await f.start(channel("ts"), 1, "ts");
    assert.equal(f.devices[0].remoteRawTsmf, true);
    assert.equal(Object.hasOwn(f.devices[0].toJSON().users[0], "_rawTsmf"), false);
    const respawned = deferred();
    const originalSpawn = f.devices[0]._spawn;
    t.mock.method(f.devices[0], "_spawn", async function (...args) {
        const result = await originalSpawn.apply(this, args); respawned.resolve(); return result;
    });
    f.processes[0].emit("close", 1, null);
    await respawned.promise;
    assert.equal(f.processes.length, 2);
    assert.equal(f.devices[0].remoteRawTsmf, true);
    for (const remote of f.processes) {
        assert.equal(remote.args.includes("decode"), false);
        assert.equal(remote.args.includes("ts"), true);
        assert.equal(remote.args.includes("rawTsmf=true"), true, "再起動でも原本転送を維持する");
    }
    await releaseDevice(f.devices[0]);
    assert.equal(f.devices[0].remoteRawTsmf, false);
    assert.equal(f.devices[0].users.length, 0);
});

for (const configured of [false, true]) {
    it(`[tuner-remote-tsmf.spec] ${configured ? "リモート展開済み" : "通常のリモートTS"}入力ではremote復号を維持する`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "remote.example", remoteMirakurunDecoder: true, decoder: "unused-local-b25" }]);
        const target = channel("ts", configured ? {} : { tsmfRelTs: undefined });
        f.devices[0].remoteChannel = configured ? { tsmfRelTs: 1 } : {};
        const { filter } = await f.start(target, configured ? 1 : undefined, "ts", { decoder: true });
        const remote = f.processes.find(proc => proc.args?.[0] === "lib/remote");
        assert.equal(remote.args.includes("decode"), true);
        assert.equal(remote.args.includes("rawTsmf=true"), false, "通常TS・展開済み入力を原本モードへ変えない");
        assert.equal(f.devices[0].remoteRawTsmf, false);
        assert.equal(filter._output instanceof TSDecoder, false);
        assert.equal(f.processes.some(proc => proc.command === "unused-local-b25"), false);
    });
}

it("[tuner-remote-tsmf.spec] 同じTS形式でも生TSMF入力とremote復号入力は合流させない", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "remote.example", remoteMirakurunDecoder: true }]);
    const target = channel("ts");
    await f.start(target, 1, "ts");
    assert.equal(f.devices[0].remoteRawTsmf, true);
    await assert.rejects(f.devices[0].startStream({ id: "decoded-remote-input", priority: 0,
        streamSetting: { channel: target, format: "ts" } }, f.output, target), /higher priority/);
    assert.equal(f.devices[0].users.length, 1);
    assert.equal(f.processes.length, 1);
});



it("[tuner-remote-tsmf.spec] 未照会remoteで搬送波不足の準備を完了しない", { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => t.mock.timers.reset());
    const f = fixture(t, [{ remoteMirakurunHost: "raw.example" }, { command: "local-carrier" }]);
    const channels = bondedChannels();
    let busy = true;
    t.mock.getter(f.devices[1], "isFree", () => !busy);
    t.mock.getter(f.devices[1], "isAvailable", () => !busy);
    let settled = false;
    const ready = f.tuner.readyForJob(channels[0]).then(value => { settled = true; return value; });
    for (let i = 0; i < 5; i++) { await new Promise(setImmediate); }
    assert.equal(settled, false);
    assert.equal(f.tuner._readyForJobPickedDeviceSet.size, 0);
    busy = false;
    t.mock.timers.tick(10000);
    assert.equal(await ready, channels[0]);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], f.devices);
});

it("[tuner-remote-tsmf.spec] 準備中のmetadata取得失敗は別ローカル候補へ切り替える", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "bad.example" }, { command: "local" }]);
    f.devices[0].remoteChannelError = new Error("metadata failed");
    const target = channel("ts");
    assert.equal(await f.tuner.readyForJob(target), target);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[1]]);
});

it("[tuner-remote-tsmf.spec] metadata照会期限までは準備を待ち、期限切れ後はローカル候補を確保する", { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => t.mock.timers.reset());
    const f = fixture(t, [{ remoteMirakurunHost: "slow.example" }, { command: "local-tuner" }]);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const deadline = t.mock.method(AbortSignal, "timeout", milliseconds => {
        assert.equal(milliseconds, 5000);
        return controller.signal;
    });
    const entered = deferred();
    const request = t.mock.method(f.devices[0], "getRemoteChannel", (_type, _channel, signal) => {
        assert.equal(signal, controller.signal);
        entered.resolve();
        return new Promise((resolve, reject) => {
            const aborted = () => reject(signal.reason);
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) { aborted(); }
        });
    });
    const target = channel("ts");
    let settled = false;
    const ready = f.tuner.readyForJob(target).then(value => { settled = true; return value; });
    void ready.catch(() => {});
    await Promise.race([
        entered.promise,
        ready.then(() => { throw new Error("metadataを確認せず準備完了を返しました"); })
    ]);
    assert.equal(settled, false);
    assert.equal(f.tuner._readyForJobPickedDeviceSet.size, 0);
    controller.abort(new Error("metadata deadline"));
    assert.equal(await ready, target);
    assert.equal(deadline.mock.callCount(), 1);
    assert.equal(request.mock.callCount(), 1);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[1]]);
});

// AbortSignal.timeoutはNodeの内部タイマーを使うため、この組だけ仮想時計へ接続する。
// 5秒の指定と、その期限がネットワーク待機を実際に中断することを別々に確かめる。
function remoteDeadlineClock(t) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const realTimeout = AbortSignal.timeout;
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", milliseconds => {
        if (milliseconds !== 5000) { return realTimeout(milliseconds); }
        const controller = new AbortController();
        deadlines.push(controller.signal);
        setTimeout(() => controller.abort(new DOMException("Remote metadata deadline", "TimeoutError")), milliseconds);
        return controller.signal;
    });
    return deadlines;
}
function holdRemoteClient(t, device) {
    const entered = deferred();
    const attempts = [];
    device.getRemoteChannel.mock.restore();
    t.mock.method(device, "_getRemoteClient", () => ({ getChannel: (_type, _channel, { signal } = {}) => new Promise((resolve, reject) => {
        const attempt = { signal, reject };
        attempts.push(attempt);
        if (signal) { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }
        entered.resolve(signal);
    }) }));
    t.after(() => { for (const attempt of attempts) { attempt.reject(new Error("test cleanup")); } });
    return { entered, attempts };
}

it("[tuner-remote-tsmf.spec] 応答しない相対TS照会は5秒で中断し別remoteでジョブを準備する", { timeout: 5000 }, async t => {
    const deadlines = remoteDeadlineClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "hung.example" }, { remoteMirakurunHost: "ready.example" }]);
    const target = channel("ts", { tsmfRelTs: undefined });
    const gate = holdRemoteClient(t, f.devices[0]);
    const controller = new AbortController(); t.after(() => controller.abort());
    const pending = f.tuner.readyForJob([{ channel: target, relTs: 2 }]);
    void pending.catch(() => {});
    const signal = await gate.entered.promise;
    assert.ok(signal instanceof AbortSignal, "相対TSの照会には停止可能なシグナルを渡す");
    assert.ok(deadlines.length > 0, "照会ごとに5秒の期限を付ける");
    t.mock.timers.tick(4999); await new Promise(setImmediate);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(await pending, target);
    assert.equal(signal.aborted, true);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[1]]);
    assert.equal(f.devices[0].canReceiveRemoteRelTs(target, 2), false, "確認できないpeerを直ちに再選択しない");
    assert.equal(f.processes.length, 0);
});

for (const kind of ["receivesRelTsByRemote", "_getRemoteTSMFStreams"]) {
    it(`[tuner-remote-tsmf.spec] ${kind}のチャンネル照会にも5秒の期限を付ける`, { timeout: 5000 }, async t => {
        const deadlines = remoteDeadlineClock(t);
        const f = fixture(t, [{ remoteMirakurunHost: "hung.example" }, { remoteMirakurunHost: "ready.example" }]);
        const target = channel("ts", { tsmfRelTs: undefined });
        const gate = holdRemoteClient(t, f.devices[0]);
        f.devices[1].remoteChannel = { services: [{ id: 400101, networkId: 4, serviceId: 101, streamId: 18001, tsmfRelTs: 2, format: "ts" }] };
        const pending = kind === "receivesRelTsByRemote"
            ? f.tuner.receivesRelTsByRemote(target.type, target.route, target.channel)
            : f.tuner._getRemoteTSMFStreams(target);
        const signal = await gate.entered.promise;
        assert.ok(signal instanceof AbortSignal);
        assert.ok(deadlines.length > 0);
        t.mock.timers.tick(5000);
        const result = await pending;
        assert.equal(signal.aborted, true);
        if (kind === "receivesRelTsByRemote") { assert.equal(result, false); }
        else { assert.deepEqual(result, [{ relTs: 2, slots: 0, format: "ts", streamId: 18001, networkId: 4 }]); }
    });
}

it("[tuner-remote-tsmf.spec] 相対TS対応そのものの照会も5秒で打ち切る", { timeout: 5000 }, async t => {
    const deadlines = remoteDeadlineClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "hung.example" }]);
    const device = f.devices[0];
    device._remoteRelTsSupported = undefined;
    const entered = deferred();
    t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamTsmfRelTs: ({ signal } = {}) => new Promise((resolve, reject) => {
        if (signal) { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }
        t.after(() => reject(new Error("test cleanup")));
        entered.resolve(signal);
    }) }));
    const pending = device.checkRemoteRelTs();
    const signal = await entered.promise;
    assert.ok(signal instanceof AbortSignal);
    assert.ok(deadlines.length > 0);
    t.mock.timers.tick(5000);
    assert.equal(await pending, false);
    assert.equal(signal.aborted, true);
    assert.equal(device.isRemoteRelTsChecked, false, "応答の確認失敗を未対応と確定しない");
});

it("[tuner-remote-tsmf.spec] 生TSMF対応の照会失敗を非対応と断定せず原因を返す", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "offline.example" }]);
    const device = f.devices[0];
    device._remoteRawTsmfSupport = undefined;
    const expected = new Error("capability connection reset");
    t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => { throw expected; } }));
    await assert.rejects(f.start(channel("ts"), 1, "ts"), error => {
        assert.equal(error.code, "ERR_TUNER_UNAVAILABLE");
        assert.equal(error.message, "リモートの生TSMF対応を確認できませんでした。");
        assert.equal(error.cause, expected);
        return true;
    });
    assert.equal(device.remoteRawTsmfCheckError, expected);
    assert.equal(f.processes.length, 0);
});

for (const remoteChannel of [{ tsmfRelTs: 0 }, {}, { tsmfRelTs: 0, services: [{ tsmfRelTs: 0 }] }]) {
    it(`[tuner-remote-tsmf.spec] リモートの相対TS 0は未指定として扱う ${JSON.stringify(remoteChannel)}`, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "legacy.example" }]);
        f.devices[0].remoteChannel = remoteChannel;
        assert.equal(await f.tuner.receivesRelTsByRemote("BS", "CATV", "C19"), false);
    });
}

it("[tuner-remote-tsmf.spec] 相対TS照会の一時失敗は64件まで保持し、期限切れを挿入時に外す", async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "offline.example" }]);
    const device = f.devices[0];
    const expected = new Error("bounded metadata error");
    device.remoteChannelError = expected;
    let now = Date.now(); t.mock.method(Date, "now", () => now);
    const targets = Array.from({ length: 70 }, (_, index) => channel("ts", { channel: `C${index}`, tsmfRelTs: undefined }));
    for (const target of targets) { assert.equal(await device.checkRemoteChannelRelTs(target, 2), false); }
    assert.equal(device._remoteChannelRelTsFailures.size, 64);
    assert.equal(device.getRemoteChannelRelTsCheckError(targets[0], 2), undefined, "上限を超えた古い失敗を外す");
    assert.equal(device.getRemoteChannelRelTsCheckError(targets[69], 2), expected, "保持した原因は元のErrorと同一");
    assert.equal(device.canReceiveRemoteRelTs(targets[69], 2), false);
    now += 10001;
    assert.equal(await device.checkRemoteChannelRelTs(channel("ts", { channel: "fresh" }), 2), false);
    assert.equal(device._remoteChannelRelTsFailures.size, 1, "期限切れのErrorを保持し続けない");
});

// 再確認は壁時計とdelayの両方で10秒を空ける。ネットワークの5秒期限も同じ時計へ接続する。
function readinessRetryClock(t) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const originalTimeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, "timeout", milliseconds => {
        if (milliseconds !== 5000) { return originalTimeout(milliseconds); }
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("metadata timeout", "TimeoutError")), milliseconds);
        return controller.signal;
    });
}
function readinessWatch(promise) {
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    return { promise, get settled() { return settled; } };
}
const readinessTurn = () => new Promise(setImmediate);

it("[tuner-remote-tsmf.spec] remote-onlyのジョブ準備は5秒照会timeoutでskipせず10秒後の成功を待つ", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "recovering.example" }]);
    const target = channel("ts"), controller = new AbortController(), entered = deferred();
    t.after(() => controller.abort());
    let calls = 0;
    t.mock.method(f.devices[0], "getRemoteChannel", async (_type, _channel, signal) => {
        if (++calls > 1) { return { tsmfRelTs: 1 }; }
        entered.resolve(signal);
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const ready = readinessWatch(f.tuner.readyForJob(target, controller.signal));
    const signal = await entered.promise;
    t.mock.timers.tick(4999); await readinessTurn();
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1); await readinessTurn();
    assert.equal(signal.aborted, true);
    assert.equal(ready.settled, false, "一時失敗をnullで返すとreadyFnがfalseとなりJobがskipされる");
    assert.equal(calls, 1);
    t.mock.timers.tick(9999); await readinessTurn();
    assert.equal(calls, 1, "失敗直後の連続照会を防ぐ");
    t.mock.timers.tick(1);
    assert.equal(await ready.promise, target);
    assert.equal(calls, 2);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[0]]);
    assert.equal(f.processes.length, 0);
});

it("[tuner-remote-tsmf.spec] 相対TS一時失敗で候補が空になっても再生成し、準備待ちを継続する", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "recovering.example" }]);
    const target = channel("ts", { tsmfRelTs: undefined }), controller = new AbortController();
    t.after(() => controller.abort());
    let calls = 0;
    t.mock.method(f.devices[0], "getRemoteChannel", async () => {
        if (++calls === 1) { throw new Error("relative metadata reset"); }
        return { services: [{ tsmfRelTs: 2 }] };
    });
    assert.equal(await f.devices[0].checkRemoteChannelRelTs(target, 2), false);
    assert.equal(f.tuner._getCandidate(target, 2).devices.length, 0, "既存negative cacheで最初の候補は省かれる");
    const ready = readinessWatch(f.tuner.readyForJob([{ channel: target, relTs: 2 }], controller.signal));
    await readinessTurn();
    assert.equal(ready.settled, false);
    const messages = event.warn.mock.calls.flatMap(call => call.arguments).filter(value => typeof value === "string");
    assert.ok(messages.some(message => message.includes("相対TSを確認できませんでした") && message.includes("再確認")));
    assert.equal(event.error.mock.calls.length, 0, "照会失敗を対応チューナーなしと誤診しない");
    t.mock.timers.tick(10000);
    assert.equal(await ready.promise, target);
    assert.equal(calls, 2);
});

it("[tuner-remote-tsmf.spec] raw能力の一時照会失敗も10秒cache後に再確認しジョブ準備を続ける", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "recovering.example" }]);
    const device = f.devices[0], target = channel("ts"), controller = new AbortController();
    t.after(() => controller.abort());
    device._remoteRawTsmfSupport = undefined;
    let calls = 0;
    t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
        if (++calls === 1) { throw new Error("capability reset"); } return true;
    } }));
    const metadata = device.getRemoteChannel;
    const ready = readinessWatch(f.tuner.readyForJob(target, controller.signal));
    await readinessTurn();
    assert.equal(ready.settled, false);
    assert.equal(calls, 1);
    t.mock.timers.tick(10000);
    assert.equal(await ready.promise, target);
    assert.equal(calls, 2);
    assert.equal(metadata.mock.callCount(), 1, "確認済みのチャンネル出力は再照会しない");
});

it("[tuner-remote-tsmf.spec] 恒久エラーのpeerは保持し、一時失敗したpeerだけ準備待ちで再照会する", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "forbidden.example" }, { remoteMirakurunHost: "recovering.example" }]);
    const target = channel("ts"), controller = new AbortController(); t.after(() => controller.abort());
    const counts = [0, 0];
    t.mock.method(f.devices[0], "getRemoteChannel", async () => { counts[0]++; throw Object.assign(new Error("forbidden"), { statusCode: 403 }); });
    t.mock.method(f.devices[1], "getRemoteChannel", async () => {
        if (++counts[1] === 1) { throw Object.assign(new Error("server unavailable"), { status: 503 }); }
        return { tsmfRelTs: 1 };
    });
    const ready = readinessWatch(f.tuner.readyForJob(target, controller.signal));
    await readinessTurn();
    assert.equal(ready.settled, false);
    assert.deepEqual(counts, [1, 1]);
    t.mock.timers.tick(10000);
    assert.equal(await ready.promise, target);
    assert.deepEqual(counts, [1, 2]);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[1]]);
});

for (const kind of ["rawUnsupported", "metadataForbidden", "invalidRelativeConfig"]) {
    it(`[tuner-remote-tsmf.spec] 確認済みの固定不適合は準備をnullで返す (${kind})`, { timeout: 5000 }, async t => {
        readinessRetryClock(t);
        const f = fixture(t, [{ remoteMirakurunHost: "incompatible.example" }]);
        if (kind === "rawUnsupported") { f.devices[0]._remoteRawTsmfSupport = { supported: false, expiresAt: Date.now() + 60000 }; }
        if (kind === "metadataForbidden") { f.devices[0].remoteChannelError = Object.assign(new Error("forbidden"), { statusCode: 403 }); }
        if (kind === "invalidRelativeConfig") { f.devices[0].remoteChannel = { tsmfRelTs: 99 }; }
        assert.equal(await f.tuner.readyForJob(channel("ts")), null);
        assert.equal(f.tuner._readyForJobPickedDeviceSet.size, 0);
        assert.equal(f.processes.length, 0);
    });
}

for (const stopping of [false]) {
    it(`[tuner-remote-tsmf.spec] remote全照会失敗後の10秒待機は${stopping ? "Tuner.close" : "abort"}ですぐ復帰する`, { timeout: 5000 }, async t => {
        readinessRetryClock(t);
        const f = fixture(t, [{ remoteMirakurunHost: "unavailable.example" }]);
        const controller = new AbortController(); t.after(() => controller.abort());
        f.devices[0].remoteChannelError = Object.assign(new Error("temporary unavailable"), { statusCode: 503 });
        const ready = readinessWatch(f.tuner.readyForJob(channel("ts"), controller.signal));
        await readinessTurn();
        assert.equal(ready.settled, false);
        if (stopping) { await f.tuner.close(); } else { controller.abort(new Error("cancel readiness retry")); }
        await assert.rejects(ready.promise);
        assert.equal(f.devices[0].getRemoteChannel.mock.callCount(), 1);
        assert.equal(f.tuner._readyForJobPickedDeviceSet.size, 0);
    });
}

it("[tuner-remote-tsmf.spec] 同じジョブ準備の一時失敗待機はerrorを繰り返さず警告を一度だけ出す", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "offline.example" }]);
    const controller = new AbortController(); t.after(() => controller.abort());
    f.devices[0].remoteChannelError = new Error("network unavailable");
    const ready = readinessWatch(f.tuner.readyForJob(channel("ts"), controller.signal));
    await readinessTurn();
    for (let retry = 0; retry < 2; retry++) { t.mock.timers.tick(10000); await readinessTurn(); }
    assert.equal(ready.settled, true, "通信障害の3回目は失敗として準備枠を返します");
    assert.equal(f.devices[0].getRemoteChannel.mock.callCount(), 3);
    assert.equal(event.error.mock.calls.length, 0);
    const waitingWarnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("10秒後に再確認します")));
    assert.equal(waitingWarnings.length, 1);
    await assert.rejects(ready.promise, error => error.code === "ERR_TUNER_UNAVAILABLE");
});

it("[tuner-remote-tsmf.spec] 相対TS照会の恒久エラーを対応チューナーなしと案内しない", async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "forbidden.example" }]);
    const target = channel("ts", { tsmfRelTs: undefined });
    f.devices[0].remoteChannelError = Object.assign(new Error("relative metadata forbidden"), { status: 403 });
    assert.equal(await f.devices[0].checkRemoteChannelRelTs(target, 2), false);
    assert.equal(await f.tuner.readyForJob([{ channel: target, relTs: 2 }]), null);
    const messages = event.error.mock.calls.flatMap(call => call.arguments).filter(value => typeof value === "string");
    assert.ok(messages.some(message => message.includes("リモートの相対TSを確認できませんでした")));
    assert.ok(messages.every(message => !message.includes("対応するチューナーがありません")));
});

it("[tuner-remote-tsmf.spec] 同一接続先4台の照会timeoutは要求内で共有し5秒一回分で再確認待ちへ進む", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, Array.from({ length: 4 }, () => ({ remoteMirakurunHost: "same.example" })));
    const target = channel("ts"), controller = new AbortController(), entered = deferred();
    t.after(() => controller.abort());
    let calls = 0;
    for (const device of f.devices) {
        t.mock.method(device, "getRemoteChannel", async (_type, _channel, signal) => {
            if (++calls > 1) { return { tsmfRelTs: 1 }; }
            entered.resolve(signal);
            return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        });
    }
    const ready = readinessWatch(f.tuner.readyForJob(target, controller.signal));
    const firstSignal = await entered.promise;
    t.mock.timers.tick(5000); await readinessTurn();
    assert.equal(firstSignal.aborted, true);
    assert.equal(calls, 1, "同じpeerの失敗を他の物理チューナー設定でも再照会しない");
    assert.equal(ready.settled, false);
    const lookupWarnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("出力を確認できないため")));
    assert.equal(lookupWarnings.length, 1);
    t.mock.timers.tick(9999); await readinessTurn();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.equal(await ready.promise, target);
    assert.equal(calls, 2, "次の再確認周期では共有した一時失敗を全台分失効させる");
    assert.equal(f.processes.length, 0);
});

for (const configured of [undefined, 1]) {
    it(`[tuner-remote-tsmf.spec] 同一接続先の照会成功を後続選択へ共有する (relTs=${configured})`, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "same.example" }, { remoteMirakurunHost: "SAME.EXAMPLE", remoteMirakurunPort: 40772 }]);
        for (const device of f.devices) { device.remoteChannel = configured === undefined ? {} : { tsmfRelTs: configured }; }
        const states = new Map(), target = channel("ts");
        await f.tuner._checkRemoteChannels([{ device: f.devices[0], channel: target }], states);
        await f.tuner._checkRemoteChannels([{ device: f.devices[1], channel: target }], states);
        assert.deepEqual(f.devices.map(device => device.getRemoteChannel.mock.callCount()), [1, 0]);
        assert.equal(states.get(f.devices[1]).has(target), true, "未設定のundefinedも確認済みとして共有する");
        assert.equal(states.get(f.devices[1]).get(target), configured);
    });
}

for (const changed of [{ remoteMirakurunHost: "other.example" }, { remoteMirakurunPort: 40773 }]) {
    it(`[tuner-remote-tsmf.spec] 実接続先・認証が異なる照会を共有しない ${JSON.stringify(changed)}`, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "same.example" }, { remoteMirakurunHost: "same.example", ...changed }]);
        const target = channel("ts"), states = new Map();
        await f.tuner._checkRemoteChannels(f.devices.map(device => ({ device, channel: target })), states);
        assert.deepEqual(f.devices.map(device => device.getRemoteChannel.mock.callCount()), [1, 1]);
    });
}

it("[tuner-remote-tsmf.spec] 同じ接続先でもチャンネル種別または識別子が異なる照会を共有しない", async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "same.example" }]);
    const states = new Map();
    for (const target of [channel("ts"), channel("ts", { channel: "C20" }), channel("tlv")]) {
        await f.tuner._checkRemoteChannels([{ device: f.devices[0], channel: target }], states);
    }
    assert.equal(f.devices[0].getRemoteChannel.mock.callCount(), 3);
});

it("[tuner-remote-tsmf.spec] 同じ接続先の恒久的な照会失敗も一度だけ確認し全候補へ共有する", async t => {
    const f = fixture(t, Array.from({ length: 4 }, () => ({ remoteMirakurunHost: "forbidden.example" })));
    for (const device of f.devices) { device.remoteChannelError = Object.assign(new Error("forbidden"), { statusCode: 403 }); }
    assert.equal(await f.tuner.readyForJob(channel("ts")), null);
    assert.equal(f.devices.reduce((total, device) => total + device.getRemoteChannel.mock.callCount(), 0), 1);
    const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("出力を確認できないため")));
    assert.equal(warnings.length, 1);
});

it("[tuner-remote-tsmf.spec] 同一peerへの別要求は照会を共有せず、一方のabortで他方を止めない", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "same.example" }]);
    const target = channel("ts"), controllers = [new AbortController(), new AbortController()];
    t.after(() => { for (const controller of controllers) { controller.abort(); } });
    const requests = [], entered = deferred();
    t.mock.method(f.devices[0], "getRemoteChannel", (_type, _channel, signal) => new Promise((resolve, reject) => {
        requests.push({ signal, resolve });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (requests.length === 2) { entered.resolve(); }
    }));
    const first = f.tuner.readyForJob(target, controllers[0].signal); void first.catch(() => {});
    const second = f.tuner.readyForJob(target, controllers[1].signal); void second.catch(() => {});
    await entered.promise;
    controllers[0].abort(new Error("first request cancelled"));
    await assert.rejects(first);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false);
    requests[1].resolve({ tsmfRelTs: 1 });
    assert.equal(await second, target);
    assert.equal(requests.length, 2);
});

it("[tuner-remote-tsmf.spec] 検出済み相対TSの同一peer群も照会失敗を共有し10秒後に復帰する", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, Array.from({ length: 4 }, () => ({ remoteMirakurunHost: "same.example" })));
    const target = channel("ts", { tsmfRelTs: undefined }), controller = new AbortController(), entered = deferred();
    t.after(() => controller.abort());
    let calls = 0;
    for (const device of f.devices) {
        t.mock.method(device, "getRemoteChannel", async (_type, _channel, signal) => {
            if (++calls > 1) { return { services: [{ tsmfRelTs: 2 }] }; }
            entered.resolve(signal);
            return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        });
    }
    const ready = readinessWatch(f.tuner.readyForJob([{ channel: target, relTs: 2 }], controller.signal));
    await entered.promise;
    t.mock.timers.tick(5000); await readinessTurn();
    assert.equal(calls, 1);
    assert.equal(ready.settled, false);
    const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("相対TSを確認できないため")));
    assert.equal(warnings.length, 1);
    t.mock.timers.tick(10000);
    assert.equal(await ready.promise, target);
    assert.equal(calls, 2);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[0]]);
});

for (const code of [2, 4]) {
    it(`[tuner-remote-tsmf.spec] remote終了コード${code}は要求を終了し、相対TS拒否だけを保持する`, { timeout: 5000 }, async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
        const target = channel("ts"), device = f.devices[0];
        await device._spawnCommand(target, 2, "ts");
        const proc = f.processes[0];
        proc.closed = true; proc.stderr.end(); proc.emit("exit", code, null); proc.emit("close", code, null);
        assert.equal(device._closing, true, "恒久要求エラーで同じ要求を再spawnしない");
        assert.equal(device._remoteRelTsRefused.has(`${target.type}/${target.channel}/2`), code === 2);
        assert.equal(device.canReceiveRemoteRelTs(target, 2), code !== 2, "認可エラーを相対TS非対応としない");
        t.mock.timers.tick(100); // 終了したprocessの解放もテストの所有期間内に終える。
    });
}

it("[tuner-remote-tsmf.spec] 生TSMF対応照会を共有し、一方の中断で他方を中断しない", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "shared.example" }]);
    const device = f.devices[0]; device._remoteRawTsmfSupport = undefined;
    const response = deferred(), controller = new AbortController();
    let lookupSignal;
    t.after(() => response.resolve(true));
    const lookup = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async ({ signal }) => {
        lookupSignal = signal; return response.promise;
    } }));
    const first = device.checkRemoteRawTsmf(controller.signal);
    const second = device.checkRemoteRawTsmf();
    const reason = new Error("cancel only one waiter"); controller.abort(reason);
    await assert.rejects(first, error => error === reason);
    assert.equal(lookup.mock.callCount(), 1, "同じデバイスの能力照会は1件だけ送る");
    assert.equal(lookupSignal.aborted, false, "能力照会は要求と別の所有者を持つ");
    response.resolve(true);
    assert.equal(await second, true);
    assert.equal(device.supportsRemoteRawTsmf, true);
});

it("[tuner-remote-tsmf.spec] 共有中の生TSMF照会失敗を1回だけ記録し、期限後に再照会する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "recover.example" }]);
    const device = f.devices[0]; device._remoteRawTsmfSupport = undefined;
    let release;
    const response = new Promise((_, reject) => { release = reject; });
    const failure = new Error("capability reset");
    let now = Date.now(); t.mock.method(Date, "now", () => now);
    const lookup = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => response }));
    const pending = [device.checkRemoteRawTsmf(), device.checkRemoteRawTsmf(), device.checkRemoteRawTsmf()];
    release(failure);
    assert.deepEqual(await Promise.all(pending), [false, false, false]);
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal(event.warn.mock.calls.filter(call => String(call.arguments).includes("生TSMF対応を確認できませんでした")).length, 1);
    assert.equal(device.remoteRawTsmfCheckError, failure);
    now += 10001;
    lookup.mock.restore();
    const recovered = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => true }));
    assert.equal(await device.checkRemoteRawTsmf(), true);
    assert.equal(recovered.mock.callCount(), 1);
});

it("[tuner-remote-tsmf.spec] 一時失敗で候補から外れた相対TSは原因付きで早く失敗する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "failed.example" }]);
    const device = f.devices[0], target = channel("ts");
    const failure = new Error("relative metadata reset");
    device._remoteChannelRelTsFailures.set(`${target.type}/${target.channel}/2`, { until: Date.now() + 10000, error: failure });
    const candidate = f.tuner._getCandidate(target, 2, "ts");
    assert.equal(candidate.devices.length, 0);
    let result;
    const pending = f.start(target, 2, "ts").then(() => { result = "resolved"; }, error => { result = error; });
    await new Promise(setImmediate);
    assert.ok(result instanceof Error, "12.5秒の空候補待機に入らない");
    assert.equal(result.code, "ERR_TUNER_UNAVAILABLE");
    assert.equal(result.cause, failure);
    assert.equal(result.message, "リモートの相対TSを確認できませんでした。");
    await pending;
    assert.equal(f.processes.length, 0);
    const recoveredAt = Date.now() + 10001;
    t.mock.method(Date, "now", () => recoveredAt);
    await f.start(target, 2, "ts");
    assert.equal(f.processes.length, 1, "失敗cacheの期限後は次の要求で再び受信できる");
    assert.equal(device.remoteRelTs, 2);
});

function busyCarrier(t, device) {
    let busy = true;
    const other = channel("tlv", { channel: "C99", tsmfRelTs: undefined });
    t.mock.getter(device, "channel", () => busy ? other : null);
    t.mock.getter(device, "isFree", () => !busy);
    t.mock.getter(device, "isUsing", () => busy);
    t.mock.getter(device, "users", () => busy ? [{ id: "existing-viewer", priority: 0 }] : []);
    t.mock.method(device, "getPriority", () => busy ? 0 : -2);
    return () => { busy = false; };
}

for (const kind of ["configured", "detected"]) {
    it(`[tuner-remote-tsmf.spec] 60秒以上の準備待機では${kind === "configured" ? "既定出力" : "検出済み相対TS"}の成功照会も更新する`, { timeout: 5000 }, async t => {
        readinessRetryClock(t);
        const f = fixture(t, [{ remoteMirakurunHost: "changing.example" }, { command: "local-carrier" }]);
        const target = kind === "configured" ? bondedChannels()[0] : channel("ts", { tsmfRelTs: undefined });
        const device = f.devices[0], controller = new AbortController(); t.after(() => controller.abort());
        if (kind === "configured") { busyCarrier(t, f.devices[1]); }
        else {
            busyCarrier(t, device);
            // 選択後の事前確認は行えるが、取得要求の開始は別利用者の解放まで待つ状態にする。
            t.mock.method(f.tuner, "_pickCarrierDevices", () => null);
            t.mock.method(f.tuner, "_getDevicesByType", () => [device]);
        }
        let calls = 0;
        t.mock.method(device, "getRemoteChannel", async () => {
            calls++;
            return kind === "configured" ? (calls === 1 ? {} : { tsmfRelTs: 1 }) : { services: [{ tsmfRelTs: 2 }] };
        });
        if (kind === "detected") {
            // busyであっても既定の確認分岐へ到達するよう、選択だけを制御する。
            const candidate = f.tuner._getCandidate(target, 2, "ts");
            t.mock.method(f.tuner, "_pickTunerDeviceWithCarriers", () => ({ picked: { device, channel: target, candidate }, carriers: null }));
        }
        const ready = readinessWatch(f.tuner.readyForJob(kind === "configured" ? target : [{ channel: target, relTs: 2 }], controller.signal));
        await readinessTurn();
        assert.equal(calls, 1);
        assert.equal(ready.settled, false);
        for (let attempt = 0; attempt < 5; attempt++) { t.mock.timers.tick(10000); await readinessTurn(); }
        assert.equal(calls, 1, "確認期限内は同じ要求の成功照会を共有する");
        t.mock.timers.tick(10000); await readinessTurn();
        assert.equal(calls, 2, "60秒で古い成功Promiseを捨て、リモートへ再照会する");
        if (kind === "configured") { assert.equal(await ready.promise, target); }
        else { controller.abort(); await assert.rejects(ready.promise); }
        assert.equal(f.processes.length, 0);
    });
}

for (const supported of [true, false]) {
    it(`[tuner-remote-tsmf.spec] 相対TS設定済みremoteの生搬送波は能力照会の${supported ? "成功後だけ確保" : "不適合で開始しない"}`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ command: "local-a" }, { remoteMirakurunHost: "carrier.example" }]);
        const channels = bondedChannels(), device = f.devices[1];
        device.remoteChannel = { tsmfRelTs: 1 }; device._remoteRawTsmfSupport = undefined;
        const candidate = { ...f.tuner._getCandidate(channels[0], 1, "tlv"), devices: [f.devices[0]] };
        const controller = new AbortController(), entered = deferred(), response = deferred();
        t.after(() => { controller.abort(); response.resolve(false); });
        const lookup = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
            entered.resolve(); return response.promise;
        } }));
        const user = { id: "raw-carrier-capability", priority: 0, disableDecoder: true, outputFormat: "tlv", streamSetting: { channel: channels[0] } };
        const refused = new Error("stop unavailable raw carrier wait");
        if (!supported) { t.mock.method(require("../lib/Mirakurun/common"), "sleep", async () => { throw refused; }); }
        const acquisition = f.tuner._initTS(user, f.output, [candidate]);
        void acquisition.catch(() => {});
        // 旧実装ではmetadataを読んだ直後にcarrierを外し、能力照会へ進まない。
        await new Promise(setImmediate);
        assert.equal(lookup.mock.callCount(), 1, "既定出力が展開済みでもraw能力を確認する");
        await entered.promise;
        assert.equal(f.processes.length, 0, "能力が未確認の間はチューナーを開始しない");
        response.resolve(supported);
        if (supported) {
            const filter = await acquisition; f.filters.push(filter);
            assert.ok(filter._bonding);
            assert.deepEqual(f.devices.map(value => value.users.length), [1, 1]);
            const proc = f.processes.find(value => value.args?.[0] === "lib/remote");
            assert.ok(proc.args.includes("rawTsmf=true"));
            assert.equal(proc.args.some(value => value.startsWith("relTs=")), false);
            assert.equal(device.remoteRawTsmf, true);
        } else {
            await new Promise(setImmediate);
            assert.equal(f.processes.length, 0);
            assert.equal(f.tuner._hasCarrierDevices(candidate, () => 1), false);
            await assert.rejects(acquisition, error => error === refused);
        }
    });
}

function finishRemoteProcess(process, code) {
    process.closed = true;
    process.stderr.end();
    process.emit("exit", code, null);
    process.emit("close", code, null);
}
function observeRemoteRelease(t, device) {
    const released = deferred(), release = device._release.bind(device);
    t.mock.method(device, "_release", () => { release(); released.resolve(); });
    return released.promise;
}
it("[tuner-remote-tsmf.spec] 生TSMFの拒否後は能力を再確認して別のremoteを確保する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "downgraded.example" }, { remoteMirakurunHost: "healthy.example" }]);
    const target = channel("ts"), device = f.devices[0];
    const lookup = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => false }));
    await f.start(target, 1, "ts");
    assert.equal(device.remoteRawTsmf, true);
    const released = observeRemoteRelease(t, device);
    finishRemoteProcess(f.processes[0], 2);
    await released;
    assert.equal(device.supportsRemoteRawTsmf, undefined, "拒否された生TSMFの古い能力情報を使い続けません");
    await f.start(target, 1, "ts");
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal(device.supportsRemoteRawTsmf, false);
    assert.equal(f.processes.length, 2);
    assert.ok(f.processes[1].args.includes("healthy.example"));
    assert.equal(f.processes[1].args.includes("downgraded.example"), false);
});
for (const [raw, code] of [[true, 4], [false, 2]]) {
    it(`[tuner-remote-tsmf.spec] 認可失敗と相対TSだけの拒否では生TSMFの能力を失効させない (raw:${raw}, code:${code})`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
        const target = channel("ts", raw ? {} : { tsmfRelTs: undefined });
        await f.start(target, raw ? 1 : 2, "ts");
        assert.equal(f.devices[0].remoteRawTsmf, raw);
        const released = observeRemoteRelease(t, f.devices[0]);
        finishRemoteProcess(f.processes[0], code);
        await released;
        assert.equal(f.devices[0].supportsRemoteRawTsmf, true);
        if (!raw) { assert.equal(f.devices[0].canReceiveRemoteRelTs(target, 2), false); }
    });
}
for (const result of [true, new Error("late capability failure")]) {
    it(`[tuner-remote-tsmf.spec] 生TSMF拒否より前に始めた照会で古い能力を復活させない (${result === true ? "success" : "failure"})`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "remote.example" }]);
        const device = f.devices[0], response = deferred(), entered = deferred();
        t.after(() => response.resolve(false));
        await f.start(channel("ts"), 1, "ts");
        device._remoteRawTsmfSupport.expiresAt = Date.now() - 1;
        const lookup = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
            entered.resolve();
            const value = await response.promise;
            if (value instanceof Error) { throw value; }
            return value;
        } }));
        const checking = device.checkRemoteRawTsmf();
        await entered.promise;
        const released = observeRemoteRelease(t, device);
        finishRemoteProcess(f.processes[0], 2);
        await released;
        response.resolve(result);
        assert.equal(await checking, false);
        assert.equal(device.supportsRemoteRawTsmf, undefined, "拒否より古い照会結果はキャッシュへ戻しません");
        lookup.mock.restore();
        t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => false }));
        assert.equal(await device.checkRemoteRawTsmf(), false);
        assert.equal(device.supportsRemoteRawTsmf, false);
    });
}


async function boundedReadinessCycle(t, milliseconds = 0) {
    t.mock.timers.tick(milliseconds);
    for (let phase = 0; phase < 4; ++phase) { await readinessTurn(); t.mock.timers.tick(0); }
}
for (const detected of [false, true]) {
    it(`[bounded-remote-ready] 同じ通信障害は要求内で一度だけ警告し、再確認上限で失敗する (detected=${detected})`, { timeout: 5000 }, async t => {
        readinessRetryClock(t);
        const f = fixture(t, [{ remoteMirakurunHost: "offline.example" }]);
        const controller = new AbortController(); t.after(() => controller.abort());
        const target = channel("ts", { tsmfRelTs: detected ? undefined : 1 });
        const failure = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
        f.devices[0].remoteChannelError = failure;
        const ready = readinessWatch(f.tuner.readyForJob(detected ? [{ channel: target, relTs: 2 }] : target, controller.signal));
        await boundedReadinessCycle(t);
        assert.equal(ready.settled, false);
        await boundedReadinessCycle(t, 10000);
        assert.equal(ready.settled, false);
        await boundedReadinessCycle(t, 10000);
        assert.equal(ready.settled, true, "通信障害で準備枠を無期限に保持しません");
        await assert.rejects(ready.promise, error => error.code === "ERR_TUNER_UNAVAILABLE" && error.cause === failure);
        assert.equal(f.devices[0].getRemoteChannel.mock.callCount(), 3);
        const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string"
            && value.includes(detected ? "相対TSを確認できないため" : "出力を確認できないため")));
        assert.equal(warnings.length, 1, "10秒の照会cache更新で警告済み印を失いません");
        assert.equal(f.tuner._readyForJobPickedDeviceSet.size, 0);
    });
}
it("[bounded-remote-ready] 3回目で回復したpeerはskipせず一度だけ準備する", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "recovering.example" }]);
    const controller = new AbortController(); t.after(() => controller.abort());
    const target = channel("ts"); let calls = 0;
    t.mock.method(f.devices[0], "getRemoteChannel", async () => {
        if (++calls < 3) { throw Object.assign(new Error("temporarily unavailable"), { statusCode: 503 }); }
        return { tsmfRelTs: 1 };
    });
    const ready = readinessWatch(f.tuner.readyForJob(target, controller.signal));
    await boundedReadinessCycle(t); await boundedReadinessCycle(t, 10000); await boundedReadinessCycle(t, 10000);
    assert.equal(await ready.promise, target);
    assert.equal(calls, 3); assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[0]]);
});
it("[bounded-remote-ready] 正常な使用中デバイスの待機を通信障害の上限で打ち切らない", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ command: "local" }]);
    const controller = new AbortController(); t.after(() => controller.abort());
    const release = busyCarrier(t, f.devices[0]), target = channel("ts");
    const ready = readinessWatch(f.tuner.readyForJob(target, controller.signal));
    for (let round = 0; round < 6; ++round) { await boundedReadinessCycle(t, 10000); assert.equal(ready.settled, false); }
    release(); await boundedReadinessCycle(t, 10000);
    assert.equal(await ready.promise, target);
});
it("[bounded-remote-ready] 別要求の照会失敗と異なる原因はそれぞれ記録する", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "changing.example" }]);
    const target = channel("ts"), first = new AbortController(), second = new AbortController();
    t.after(() => { first.abort(); second.abort(); });
    f.devices[0].remoteChannelError = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const ready = readinessWatch(f.tuner.readyForJob(target, first.signal));
    await boundedReadinessCycle(t);
    f.devices[0].remoteChannelError = Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
    await boundedReadinessCycle(t, 10000);
    first.abort(new Error("stop first request")); await assert.rejects(ready.promise);
    const other = readinessWatch(f.tuner.readyForJob(target, second.signal));
    await boundedReadinessCycle(t);
    second.abort(new Error("stop second request")); await assert.rejects(other.promise);
    const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("出力を確認できないため")));
    assert.equal(warnings.length, 3);
});
for (const retryOnFail of [false, true]) {
    it(`[bounded-remote-ready] 実Jobの準備枠1でも停止peerの後のローカルJobを開始し失敗をskipしない (retryOnFail=${retryOnFail})`, { timeout: 5000 }, async t => {
        readinessRetryClock(t);
        const f = fixture(t, [{ remoteMirakurunHost: "offline.example", types: ["BS"] }, { command: "local", types: ["GR"] }]);
        const controller = new AbortController();
        _.config.server.jobMaxStandby = 1; _.config.server.jobMaxRunning = 1;
        const Job = require("../lib/Mirakurun/Job").default, scheduler = new Job();
        t.after(async () => {
            controller.abort(new Error("test cleanup"));
            if (scheduler.close) { await scheduler.close(); }
            else { clearInterval(scheduler._scheduleInterval); clearTimeout(scheduler._queueCheckTimeout); }
        });
        const remote = channel("ts"), local = new ChannelItem({ type: "GR", channel: "27", name: "local" });
        const order = []; let remoteRuns = 0, localRuns = 0;
        f.devices[0].remoteChannelError = Object.assign(new Error("remote offline"), { code: "ECONNREFUSED" });
        scheduler.add({ key: "remote", name: "remote", retryOnFail, retryMax: 1, retryDelay: 60000,
            readyFn: async signal => (await f.tuner.readyForJob(remote, signal ?? controller.signal)) !== null,
            fn: async () => { ++remoteRuns; order.push("remote"); } });
        scheduler.add({ key: "local", name: "local", readyFn: async signal => (await f.tuner.readyForJob(local, signal ?? controller.signal)) !== null,
            fn: async () => { ++localRuns; order.push("local"); } });
        await boundedReadinessCycle(t); await boundedReadinessCycle(t, 10000); await boundedReadinessCycle(t, 10000);
        await boundedReadinessCycle(t, 1000);
        assert.equal(localRuns, 1, "障害peerの準備枠が解放され、無関係のローカルJobが進みます");
        assert.equal(remoteRuns, 0);
        const failed = scheduler._finishedJobItems.find(job => job.key === "remote");
        assert.ok(failed); assert.equal(failed.hasFailed, true); assert.equal(failed.hasSkipped, false); assert.equal(failed.hasAborted, false);
        assert.equal(failed.error.code, "ERR_TUNER_UNAVAILABLE");
        assert.equal(scheduler.jobs.some(job => job.key === "remote" && job.status === "standby"), false);
        assert.deepEqual(order, ["local"]);
        f.devices[0].remoteChannelError = undefined; f.devices[0].remoteChannel = { tsmfRelTs: 1 };
        await boundedReadinessCycle(t, 60000);
        assert.equal(remoteRuns, retryOnFail ? 1 : 0);
        assert.deepEqual(order, retryOnFail ? ["local", "remote"] : ["local"]);
        const attempts = scheduler._finishedJobItems.filter(job => job.key === "remote");
        assert.equal(attempts.length, retryOnFail ? 2 : 1);
        if (retryOnFail) { assert.equal(attempts[0].hasFailed, false); assert.equal(attempts[0].retryCount, 1); }
    });
}


for (const detected of [false, true]) {
    it(`[bounded-remote-ready] 同原因の警告済み記録は10秒後の再照会にも引き継ぐ (detected=${detected})`, { timeout: 5000 }, async t => {
        readinessRetryClock(t);
        const f = fixture(t, [{ remoteMirakurunHost: "offline.example" }]);
        const target = channel("ts", { tsmfRelTs: detected ? undefined : 1 }), controller = new AbortController();
        t.after(() => controller.abort());
        f.devices[0].remoteChannelError = Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
        const ready = readinessWatch(f.tuner.readyForJob(detected ? [{ channel: target, relTs: 2 }] : target, controller.signal));
        await boundedReadinessCycle(t); await boundedReadinessCycle(t, 10000);
        assert.equal(f.devices[0].getRemoteChannel.mock.callCount(), 2);
        const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string"
            && value.includes(detected ? "相対TSを確認できないため" : "出力を確認できないため")));
        assert.equal(warnings.length, 1);
        controller.abort(new Error("cancel after two failures")); await assert.rejects(ready.promise);
    });
}
it("[bounded-remote-ready] 5秒ずつtimeoutする照会も3回と待機2回で準備を終える", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "silent.example" }]), controller = new AbortController();
    t.after(() => controller.abort());
    const signals = [], startedAt = Date.now();
    t.mock.method(f.devices[0], "getRemoteChannel", (_type, _channel, signal) => new Promise((_resolve, reject) => {
        signals.push(signal); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const ready = readinessWatch(f.tuner.readyForJob(channel("ts"), controller.signal));
    await boundedReadinessCycle(t);
    for (let attempt = 0; attempt < 3; ++attempt) {
        await boundedReadinessCycle(t, 5000);
        if (attempt < 2) { assert.equal(ready.settled, false); await boundedReadinessCycle(t, 10000); }
    }
    assert.equal(ready.settled, true);
    await assert.rejects(ready.promise, error => error.code === "ERR_TUNER_UNAVAILABLE" && error.cause?.name === "TimeoutError");
    assert.equal(Date.now() - startedAt, 35000);
    assert.equal(signals.length, 3); assert.ok(signals.every(signal => signal.aborted));
});
it("[bounded-remote-ready] 生TSMF能力照会の反復も同じ要求では一度だけ警告する", { timeout: 5000 }, async t => {
    readinessRetryClock(t);
    const f = fixture(t, [{ remoteMirakurunHost: "raw-offline.example" }]), controller = new AbortController();
    t.after(() => controller.abort());
    const device = f.devices[0]; device._remoteRawTsmfSupport = undefined;
    let calls = 0;
    t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
        ++calls; throw Object.assign(new Error("capability offline"), { code: "ECONNREFUSED" });
    } }));
    const ready = readinessWatch(f.tuner.readyForJob(channel("ts"), controller.signal));
    await boundedReadinessCycle(t); await boundedReadinessCycle(t, 10000); await boundedReadinessCycle(t, 10000);
    assert.equal(ready.settled, true);
    await assert.rejects(ready.promise, error => error.code === "ERR_TUNER_UNAVAILABLE");
    assert.equal(calls, 3);
    const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("生TSMF対応を確認できませんでした (") ));
    assert.equal(warnings.length, 1);
});


for (const unavailable of [false, true]) {
    it(`[bounded-remote-ready] 準備の一時失敗だけを既定間隔で再試行し、先にlocal Jobを進める (unavailable=${unavailable})`, { timeout: 5000 }, async t => {
        readinessRetryClock(t);
        _.config.server.jobMaxStandby = 1; _.config.server.jobMaxRunning = 1;
        const Job = require("../lib/Mirakurun/Job").default, scheduler = new Job();
        t.after(async () => {
            if (scheduler.close) { await scheduler.close(); }
            else { clearInterval(scheduler._scheduleInterval); clearTimeout(scheduler._queueCheckTimeout); }
        });
        let checks = 0; const order = [];
        scheduler.add({ key: "remote", name: "remote", retryOnFail: true, retryMax: 1,
            readyFn: async () => {
                ++checks;
                if (checks > 1) { return true; }
                throw Object.assign(new Error("readiness failed"), unavailable ? { code: "ERR_TUNER_UNAVAILABLE" } : {});
            },
            fn: async () => { order.push("remote"); } });
        scheduler.add({ key: "local", name: "local", fn: async () => { order.push("local"); } });
        await boundedReadinessCycle(t); await boundedReadinessCycle(t, 1000); await boundedReadinessCycle(t, 1000);
        assert.deepEqual(order, unavailable ? ["local", "remote"] : ["local"]);
        assert.equal(checks, unavailable ? 2 : 1);
        const attempts = scheduler._finishedJobItems.filter(job => job.key === "remote");
        assert.equal(attempts.length, unavailable ? 2 : 1);
        const initial = attempts.at(-1);
        assert.equal(initial.hasFailed, unavailable);
        assert.equal(initial.hasSkipped, !unavailable);
        if (unavailable) { assert.equal(initial.error.code, "ERR_TUNER_UNAVAILABLE"); assert.equal(attempts[0].retryCount, 1); }
    });
}


for (const support of ["failed", "unsupported", "unknown"]) {
    it(`[active-raw-join] 動作中の一致するraw入力は能力確認${support}でも再照会せず共有する`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "active.example" }]);
        const target = channel("ts"), device = f.devices[0];
        await f.start(target, 1, "ts");
        assert.equal(device.remoteRawTsmf, true); assert.equal(device.remoteFormat, "ts");
        const before = device.getRemoteChannel.mock.callCount();
        device._remoteRawTsmfSupport = support === "unknown" ? undefined : { supported: false, expiresAt: Date.now() + 60000,
            ...(support === "failed" && { error: Object.assign(new Error("capability lookup failed"), { code: "ECONNREFUSED" }) }) };
        device.remoteChannelError = Object.assign(new Error("metadata endpoint unavailable"), { code: "ECONNREFUSED" });
        const check = t.mock.method(device, "checkRemoteRawTsmf", async () => { throw new Error("active input must not wait for capability metadata"); });
        await f.start(target, 1, "ts");
        const explicit = await f.tuner.initChannelStream(target, { id: "explicit-raw-join", priority: 0 }, f.output, undefined, true);
        f.filters.push(explicit);
        assert.equal(f.processes.length, 1); assert.equal(device.users.length, 3);
        assert.equal(device.getRemoteChannel.mock.callCount(), before);
        assert.equal(check.mock.callCount(), 0);
        assert.equal(device.supportsRemoteRawTsmf, support === "unknown" ? undefined : false, "失敗情報は新規起動のために維持します");
    });
}
it("[active-raw-join] 結合の準備と確保も配信中のraw搬送波を能力失敗で除外しない", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "active-carrier.example" }, { command: "local" }]);
    const [target, carrier] = bondedChannels(), device = f.devices[0];
    const raw = await f.tuner.initChannelStream(carrier, { id: "raw-carrier", priority: 0 }, f.output, undefined, true);
    f.filters.push(raw);
    assert.equal(device.channel, carrier); assert.equal(device.remoteRawTsmf, true);
    device._remoteRawTsmfSupport = { supported: false, expiresAt: Date.now() + 60000, error: new Error("metadata unavailable") };
    device.remoteChannelError = new Error("metadata unavailable");
    const before = device.getRemoteChannel.mock.callCount();
    const candidate = f.tuner._getCandidate(target, 1, "tlv");
    assert.equal(f.tuner._hasCarrierDevices(candidate), true);
    const controller = new AbortController(); t.after(() => controller.abort());
    assert.equal(await f.tuner.readyForJob(target, controller.signal), target);
    controller.abort();
    await f.start(target, 1, "tlv");
    assert.equal(f.processes.length, 2); assert.equal(device.users.length, 2); assert.equal(f.devices[1].users.length, 1);
    assert.equal(device.getRemoteChannel.mock.callCount(), before);
});
for (const mismatch of ["channel", "relative", "format", "raw", "unavailable"]) {
    it(`[active-raw-join] 一致しない既存入力は能力非対応の例外にしない (${mismatch})`, { timeout: 5000 }, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "active.example" }]);
        const target = channel("ts"), device = f.devices[0];
        await f.start(target, 1, "ts");
        device._remoteRawTsmfSupport = { supported: false, expiresAt: Date.now() + 60000, error: new Error("lookup unavailable") };
        const requested = mismatch === "channel" ? channel("ts", { channel: "C99" }) : target;
        if (mismatch === "relative") t.mock.getter(device, "remoteRelTs", () => 2);
        if (mismatch === "format") t.mock.getter(device, "remoteFormat", () => "tlv");
        if (mismatch === "raw") t.mock.getter(device, "remoteRawTsmf", () => false);
        if (mismatch === "unavailable") t.mock.getter(device, "isAvailable", () => false);
        const candidate = { ...f.tuner._getCandidate(requested, 1, "ts"), rawTsmf: true };
        assert.equal(f.tuner._pickTunerDevice([candidate], 0), null);
        assert.equal(f.processes.length, 1); assert.equal(device.users.length, 1);
    });
}
it("[active-raw-join] 空いている非対応デバイスの新規raw起動は許可しない", t => {
    const f = fixture(t, [{ remoteMirakurunHost: "inactive.example" }]), target = channel("ts");
    f.devices[0]._remoteRawTsmfSupport = { supported: false, expiresAt: Date.now() + 60000 };
    assert.equal(f.tuner._pickTunerDevice([{ ...f.tuner._getCandidate(target, 1, "ts"), rawTsmf: true }], 0), null);
    assert.equal(f.processes.length, 0); assert.equal(f.devices[0].users.length, 0);
});


it("[active-raw-join] 照会await中に始まったraw入力は遅い展開済みmetadataより優先する", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "concurrent.example" }, { command: "local" }]);
    const [target, carrier] = bondedChannels(), device = f.devices[0];
    const entered = deferred(), response = deferred();
    t.after(() => response.resolve({ tsmfRelTs: 1, services: [] }));
    t.mock.method(device, "getRemoteChannel", async () => { entered.resolve(); return response.promise; });
    const pending = f.start(target, 1, "tlv");
    void pending.catch(() => {});
    await entered.promise;
    const raw = await f.tuner.initChannelStream(target, { id: "concurrent-raw", priority: 0 }, f.output, undefined, true);
    f.filters.push(raw);
    assert.equal(device.remoteRawTsmf, true); assert.equal(device.remoteFormat, "ts");
    response.resolve({ tsmfRelTs: 1, services: [] });
    const { filter } = await pending;
    assert.ok(filter._bonding, "実際のraw入力をローカルで分離・結合するfilterを作ります");
    assert.equal(filter._tsmf, null);
    assert.equal(f.devices[1].channel, carrier);
    assert.equal(device.users.length, 2); assert.equal(f.devices[1].users.length, 1);
    assert.equal(f.processes.length, 2);
    assert.equal(device.getRemoteChannel.mock.callCount(), 1);
});


for (const format of ["ts", "tlv"]) {
    for (const idle of [false, true]) {
        it(`[raw-relative-takeover] ${idle ? "3秒の待機中" : "高優先度の横取り"}に生TSMFから検出済み相対TSへ切り替える (${format})`, { timeout: 5000 }, async t => {
            const f = fixture(t, [{ remoteMirakurunHost: "raw-relative.example" }]);
            const target = channel(format), device = f.devices[0];
            t.mock.getter(target, "streams", () => [{ networkId: 4, streamId: 2, relTs: 2, format }]);
            t.mock.method(target, "getServices", () => []);
            const rawOutput = new Writable({ write(chunk, encoding, callback) { callback(); } });
            t.after(() => rawOutput.destroy());
            const raw = await f.tuner.initChannelStream(target, { id: "raw-owner", priority: 0 }, rawOutput, undefined, true);
            f.filters.push(raw);
            assert.ok(f.processes[0].args.includes("rawTsmf=true"));
            assert.equal(device.remoteRawTsmf, true);
            if (idle) {
                raw.close(false);
                assert.equal(device.users.length, 0);
                assert.ok(device._endStreamTimer, "最後の利用者が離れた後の停止待機を通る");
                assert.equal(f.processes[0].closed, false);
            }
            const filter = await f.tuner.initChannelStream(target,
                { id: "relative-owner", priority: idle ? 0 : 1, disableDecoder: true, outputFormat: format },
                f.output, 2);
            f.filters.push(filter);
            assert.equal(f.processes.length, 2, "入力を一度だけ切り替える");
            assert.equal(f.processes[0].closed, true);
            const remote = f.processes[1];
            assert.ok(remote.args.includes("relTs=2"));
            assert.equal(remote.args.includes("rawTsmf=true"), false, "相対TSの取得に生TSMF指定を混在させない");
            assert.ok(remote.args.includes(format));
            assert.equal(device.remoteRawTsmf, false);
            assert.equal(device.remoteRelTs, 2);
            assert.equal(device.remoteFormat, format);
            assert.deepEqual(device.users.map(user => user.id), ["relative-owner"]);
            assert.equal(format === "ts" ? filter._tsmfEnableTsmfSplit : filter._tsmf !== null, false, "展開済みデータを再展開しない");
            const received = content(format);
            remote.stdout.write(received); device._flushUsers(); filter.flush();
            assert.deepEqual(Buffer.concat(f.writes), received, "切り替え後の展開済みデータを出力する");
        });
    }
}

it("[raw-relative-takeover] リモートが結合する検出済みTLVの切り替えにはローカル搬送波を要求しない", { timeout: 5000 }, async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "raw-bonded.example" }]);
    const target = channel("tlv"), other = channel("tlv", { channel: "C20" });
    const raw = await f.tuner.initChannelStream(target, { id: "raw-carrier", priority: 0 }, f.output, undefined, true);
    f.filters.push(raw);
    t.mock.method(target, "getBondedChannels", () => [target, other]);
    const candidate = f.tuner._getCandidate(target, 2, "tlv");
    assert.equal(f.tuner._hasCarrierDevices(candidate), true);
    assert.deepEqual(f.tuner._pickCarrierDevices({ device: f.devices[0], channel: target, candidate }, 1), [],
        "生TSMFの既存入力があっても、明示相対TSはリモート側の結合へ切り替える");
});

for (const format of ["ts", "tlv"]) {
    for (const state of ["same", "known", "unknown"]) {
        const otherDevice = state !== "same";
        it(`[tuner-remote-tsmf.spec] decoder待機中に${otherDevice ? "同一接続先の別デバイス" : "同じデバイス"}が生TSMFを開始したら入力責務を再判定する (${format}, ${state})`, { timeout: 5000 }, async t => {
            const f = fixture(t, Array.from({ length: otherDevice ? 2 : 1 }, () => ({
                remoteMirakurunHost: "same.example", decoder: "same-decoder", tlvToTsDecoder: "same-converter"
            })));
            const target = channel(format), rawDevice = f.devices[otherDevice ? 1 : 0];
            for (const device of f.devices) { device.remoteChannel = { tsmfRelTs: 1 }; }
            const candidate = { channel: target, relTs: 1, format, devices: f.devices };
            if (state === "known") {
                // 前の選択で両デバイスの設定が照会済みでも、実際の入力はdecoder待機中に変化する。
                let preflight = true;
                const pick = f.tuner._pickTunerDeviceWithCarriers.bind(f.tuner);
                t.mock.method(f.tuner, "_pickTunerDeviceWithCarriers", (...args) => preflight
                    ? { picked: { device: rawDevice, channel: target, candidate }, carriers: [] } : pick(...args));
                const read = rawDevice.getRemoteChannel.bind(rawDevice);
                t.mock.method(rawDevice, "getRemoteChannel", async (...args) => { preflight = false; return read(...args); });
            }
            const entered = deferred(), resume = deferred();
            let waits = 0;
            t.mock.method(TSDecoder.prototype, "waitForStart", async () => {
                if (++waits === 1) { entered.resolve(); await resume.promise; }
            });
            t.after(() => resume.resolve());
            const user = { id: "decoder-raw-reselection", priority: 0, outputFormat: "ts", streamSetting: { channel: target } };
            const running = f.tuner._initTS(user, f.output, [candidate]);
            void running.catch(() => {});
            await entered.promise;
            const rawOutput = new PassThrough(); rawOutput.flush = () => {};
            t.after(() => { rawOutput.removeAllListeners("close"); rawOutput.destroy(); });
            await rawDevice.startStream({ id: "concurrent-raw", priority: 0, disableDecoder: true, _rawTsmf: true,
                streamSetting: { channel: target, format: "ts" } }, rawOutput, target);
            const remote = f.processes.find(proc => proc.args?.[0] === "lib/remote");
            assert.ok(remote.args.includes("rawTsmf=true"));
            resume.resolve();
            const filter = await running;
            f.filters.push(filter);
            assert.equal(waits, 2, "実際の入力責務が変わったためfilterとdecoderを再作成します");
            assert.equal(user._rawTsmf, true);
            assert.equal(user.streamSetting.format, "ts");
            assert.equal(format === "ts" ? filter._tsmfEnableTsmfSplit : filter._tsmf !== null, true);
            assert.equal(rawDevice.users.length, 2, "先行する生入力へ正しく合流します");
            assert.equal(remote.closed, false, "先行する利用者のプロセスを終了しません");
            assert.equal(f.processes.filter(proc => proc.args?.[0] === "lib/remote").length, 1);
            if (otherDevice) { assert.equal(f.devices[0].users.length, 0); }
        });
    }
}

for (const decisions of [[false, true], [true, false]]) {
    it(`[raw-capability-report] 共有した失敗を途中参加した要求にも通知し、警告は一度だけ出す (${decisions})`, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "shared.example" }]), device = f.devices[0];
        device._remoteRawTsmfSupport = undefined;
        const entered = deferred(), response = deferred(), failure = new Error("shared capability failure");
        t.after(() => response.resolve(true));
        const read = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
            entered.resolve(); await response.promise; throw failure;
        } }));
        const reports = [[], []];
        const first = device.checkRemoteRawTsmf(undefined, error => { reports[0].push(error); return decisions[0]; });
        await entered.promise;
        const joined = device.checkRemoteRawTsmf(undefined, error => { reports[1].push(error); return decisions[1]; });
        response.resolve();
        assert.deepEqual(await Promise.all([first, joined]), [false, false]);
        assert.deepEqual(reports, [[failure], [failure]], "合流側の要求にも障害を記録します");
        assert.equal(read.mock.callCount(), 1);
        const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("生TSMF対応を確認できませんでした")));
        assert.equal(warnings.length, 1, "同じ共有照会の障害を重複して記録しません");
        assert.equal(await device.checkRemoteRawTsmf(undefined, () => { throw new Error("キャッシュを再通知しません"); }), false);
        assert.equal(read.mock.callCount(), 1);
    });
}

it("[raw-capability-report] 合流側の中断は自分の待機と失敗通知だけを止め、共有照会は継続する", async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "shared.example" }]), device = f.devices[0];
    device._remoteRawTsmfSupport = undefined;
    const entered = deferred(), response = deferred(), controller = new AbortController();
    const failure = new Error("owned lookup failure"), cancelled = new Error("caller cancelled");
    t.after(() => response.resolve(true));
    let lookupSignal;
    const read = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async ({ signal }) => {
        lookupSignal = signal; entered.resolve(); await response.promise; throw failure;
    } }));
    const reports = [[], [], []];
    const report = index => error => { reports[index].push(error); return true; };
    const first = device.checkRemoteRawTsmf(undefined, report(0));
    await entered.promise;
    const aborted = device.checkRemoteRawTsmf(controller.signal, report(1));
    const remaining = device.checkRemoteRawTsmf(undefined, report(2));
    controller.abort(cancelled);
    await assert.rejects(aborted, error => error === cancelled);
    assert.equal(lookupSignal.aborted, false, "要求の中断ではデバイス所有の照会を止めません");
    response.resolve();
    assert.deepEqual(await Promise.all([first, remaining]), [false, false]);
    assert.deepEqual(reports, [[failure], [], [failure]]);
    assert.equal(read.mock.callCount(), 1);
    const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("生TSMF対応を確認できませんでした")));
    assert.equal(warnings.length, 1);
});

for (const supported of [false, true]) {
    it(`[raw-capability-report] 共有照会の正常応答では失敗callbackを呼ばない (${supported})`, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "shared.example" }]), device = f.devices[0];
        device._remoteRawTsmfSupport = undefined;
        const entered = deferred(), response = deferred();
        t.after(() => response.resolve(supported));
        const read = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
            entered.resolve(); return response.promise;
        } }));
        let reports = 0;
        const report = () => { reports++; return true; };
        const first = device.checkRemoteRawTsmf(undefined, report);
        await entered.promise;
        const joined = device.checkRemoteRawTsmf(undefined, report);
        response.resolve(supported);
        assert.deepEqual(await Promise.all([first, joined]), [supported, supported]);
        assert.equal(reports, 0);
        assert.equal(read.mock.callCount(), 1);
    });
}

it("[raw-capability-report] 合流した要求が次の照会を始めても同じ障害の警告を繰り返さない", async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "shared.example" }]), device = f.devices[0];
    device._remoteRawTsmfSupport = undefined;
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const entered = deferred(), response = deferred(), failure = new Error("repeated capability failure");
    t.after(() => response.resolve());
    const read = t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => {
        entered.resolve(); await response.promise; throw failure;
    } }));
    const reports = [new Set(), new Set()];
    const report = index => error => { const seen = reports[index].has(error.message); reports[index].add(error.message); return !seen; };
    const first = device.checkRemoteRawTsmf(undefined, report(0));
    await entered.promise;
    const joined = device.checkRemoteRawTsmf(undefined, report(1));
    response.resolve();
    assert.deepEqual(await Promise.all([first, joined]), [false, false]);
    now += 10001;
    assert.equal(await device.checkRemoteRawTsmf(undefined, report(1)), false);
    assert.equal(read.mock.callCount(), 2);
    const warnings = event.warn.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && value.includes("生TSMF対応を確認できませんでした")));
    assert.equal(warnings.length, 1, "前回の共有失敗を記録した要求では同じ警告を増やしません");
});

for (const mode of ["ts", "tlv", "bonded-tlv"]) {
    for (const decoder of [false, true]) {
        it(`[remote-input-continuity] peerの相対TS設定を削除しても配信中の展開済み入力へ合流する (${mode}, decoder=${decoder})`, { timeout: 5000 }, async t => {
            const format = mode === "ts" ? "ts" : "tlv";
            const f = fixture(t, [{ remoteMirakurunHost: "changed.example", decoder: "local-decoder", tlvToTsDecoder: "local-converter" }]);
            const target = mode === "bonded-tlv" ? bondedChannels()[0] : channel(format);
            const device = f.devices[0];
            device.remoteChannel = { tsmfRelTs: 1 };
            await f.start(target, 1, format);
            const remote = f.processes.find(proc => proc.args?.[0] === "lib/remote");
            assert.equal(device.remoteRawTsmf, false);
            device.remoteChannel = {};
            const entered = deferred(), resume = deferred();
            t.after(() => resume.resolve());
            let waits = 0;
            if (decoder) {
                t.mock.method(TSDecoder.prototype, "waitForStart", async () => {
                    if (++waits === 1) { entered.resolve(); await resume.promise; }
                });
            }
            const requestedFormat = decoder ? "ts" : format;
            const user = { id: "join-after-peer-change", priority: decoder ? 1 : 0, disableDecoder: !decoder,
                outputFormat: requestedFormat, streamSetting: { channel: target } };
            const candidate = f.tuner._getCandidate(target, 1, format);
            const running = f.tuner._initTS(user, f.output, [candidate]);
            void running.catch(() => {});
            if (decoder) {
                await Promise.race([entered.promise, running.then(() => { throw new Error("decoderの準備待機を通りませんでした"); })]);
                assert.equal(remote.closed, false, "準備待機中も先行する視聴を維持します");
                resume.resolve();
            }
            const filter = await running;
            f.filters.push(filter);
            assert.equal(device.getRemoteChannel.mock.callCount(), 2, "変更後の設定を照会します");
            assert.equal(user._rawTsmf, false, "選択時と開始時で同じ展開済み入力を使います");
            assert.equal(user.streamSetting.tsmfRelTs, undefined);
            assert.equal(format === "ts" ? filter._tsmfEnableTsmfSplit : filter._tsmf !== null, false, "受信済みの相対TSを二重に展開しません");
            assert.equal(device.users.length, 2);
            assert.equal(remote.closed, false, "既存の視聴者を追い出しません");
            assert.equal(f.processes.filter(proc => proc.args?.[0] === "lib/remote").length, 1, "raw入力で起動し直しません");
            if (decoder) { assert.equal(waits, 1, "展開責務を取り違えてdecoderを作り直し続けません"); }
            else {
                const payload = format === "ts" ? content("ts") : Buffer.concat(Array.from({ length: 8 }, () => {
                    const packet = Buffer.alloc(188); packet[0] = 0x7F; packet[1] = 0xFF; packet.writeUInt16BE(184, 2); return packet;
                }));
                f.writes.length = 0;
                remote.stdout.write(payload);
                device._flushUsers();
                assert.equal(Buffer.concat(f.writes).length, payload.length * 2, "同じ入力が双方の利用者へ届きます");
            }
            if (mode === "bonded-tlv") {
                assert.equal(f.tuner._hasCarrierDevices(candidate, () => undefined), true, "配信中の結合結果へ合流するため追加搬送波を要求しません");
            }
        });
    }
}

for (const mismatch of ["relTs", "format"]) {
    for (const supported of [false, true]) {
        it(`[remote-input-continuity] ${mismatch}が異なる配信へ誤合流せず、生TSMF能力に従ってtakeoverする (supported=${supported})`, { timeout: 5000 }, async t => {
            const f = fixture(t, [{ remoteMirakurunHost: "changed.example" }]);
            const target = channel("ts"), device = f.devices[0];
            const previous = new PassThrough(); previous.flush = () => {};
            t.after(() => { previous.removeAllListeners("close"); previous.destroy(); });
            await device.startStream({ id: "different-input", priority: 0, disableDecoder: true, _rawTsmf: false,
                streamSetting: { channel: target, format: mismatch === "format" ? "tlv" : "ts",
                    tsmfRelTs: mismatch === "relTs" ? 2 : undefined } }, previous, target);
            const remote = f.processes[0];
            device._remoteRawTsmfSupport = { supported, expiresAt: Date.now() + 60000 };
            const user = { id: "higher-priority-raw", priority: 1, disableDecoder: true, outputFormat: "ts", streamSetting: { channel: target } };
            const candidate = f.tuner._getCandidate(target, 1, "ts");
            const running = f.tuner._initTS(user, f.output, [candidate]);
            if (!supported) {
                await assert.rejects(running, error => error.code === "ERR_TUNER_UNAVAILABLE");
                assert.equal(remote.closed, false, "非対応peerの既存入力は停止しません");
                assert.equal(device.users.length, 1);
                assert.equal(f.processes.length, 1);
            } else {
                const filter = await running; f.filters.push(filter);
                assert.equal(user._rawTsmf, true, "再起動するときは未設定peerから外側TSを要求します");
                assert.equal(filter._tsmfEnableTsmfSplit, true);
                assert.equal(remote.closed, true, "優先度に従って別入力へ切り替えます");
                assert.equal(f.processes.length, 2);
                assert.ok(f.processes[1].args.includes("rawTsmf=true"));
                assert.equal(f.processes[1].args.some(arg => arg.startsWith("relTs=")), false);
                assert.equal(device.users.length, 1);
            }
        });
    }
}

for (const cached of [false, true]) {
    it(`[tuner-remote-tsmf.spec] ジョブ準備は生TSMF非対応を原因付きで記録する (cached=${cached})`, async t => {
        const f = fixture(t, [{ remoteMirakurunHost: "unsupported-raw.example" }]);
        const device = f.devices[0];
        device._remoteRawTsmfSupport = cached ? { supported: false, expiresAt: Date.now() + 60000 } : undefined;
        let checks = 0;
        t.mock.method(device, "_getRemoteClient", () => ({ supportsChannelStreamRawTsmf: async () => { checks++; return false; } }));
        assert.equal(await f.tuner.readyForJob(channel("ts")), null);
        const errors = event.error.mock.calls.flatMap(call => call.arguments).filter(value => typeof value === "string").join(" ");
        assert.match(errors, /生TSMFの取得に対応するチューナーがありません/);
        assert.doesNotMatch(errors, /❌ 対応するチューナーがありません/);
        assert.equal(checks, cached ? 0 : 1);
        assert.equal(f.tuner._readyForJobPickedDeviceSet.size, 0);
        assert.equal(f.processes.length, 0);
    });
}
it("[tuner-remote-tsmf.spec] ジョブ準備の生TSMF照会失敗を非対応と断定しない", async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "forbidden-capability.example" }]);
    const failure = Object.assign(new Error("capability forbidden"), { statusCode: 403 });
    f.devices[0]._remoteRawTsmfSupport = { supported: false, expiresAt: Date.now() + 60000, error: failure };
    assert.equal(await f.tuner.readyForJob(channel("ts")), null);
    const errors = event.error.mock.calls.flatMap(call => call.arguments).filter(value => typeof value === "string").join(" ");
    assert.match(errors, /リモートの生TSMF対応を確認できませんでした/);
    assert.doesNotMatch(errors, /生TSMFの取得に対応するチューナーがありません/);
    assert.equal(f.tuner._readyForJobPickedDeviceSet.size, 0);
    assert.equal(f.processes.length, 0);
});
it("[tuner-remote-tsmf.spec] ジョブ準備にローカル代替があれば非対応remoteのエラーを出さない", async t => {
    const f = fixture(t, [{ remoteMirakurunHost: "unsupported-raw.example" }, { command: "fixture-local" }]);
    f.devices[0]._remoteRawTsmfSupport = { supported: false, expiresAt: Date.now() + 60000 };
    const target = channel("ts"), controller = new AbortController();
    t.after(() => controller.abort());
    assert.equal(await f.tuner.readyForJob(target, controller.signal), target);
    assert.deepEqual([...f.tuner._readyForJobPickedDeviceSet], [f.devices[1]]);
    assert.equal(event.error.mock.callCount(), 0);
    assert.equal(f.devices[0].getRemoteChannel.mock.callCount(), 0);
    assert.equal(f.processes.length, 0);
});
it("[tuner-remote-tsmf.spec] ジョブ準備の候補なしは生TSMF非対応と断定しない", async t => {
    const f = fixture(t, []);
    assert.equal(await f.tuner.readyForJob(channel("ts")), null);
    const errors = event.error.mock.calls.flatMap(call => call.arguments).filter(value => typeof value === "string").join(" ");
    assert.match(errors, /❌ 対応するチューナーがありません/);
    assert.doesNotMatch(errors, /生TSMF/);
    assert.equal(f.tuner._readyForJobPickedDeviceSet.size, 0);
    assert.equal(f.processes.length, 0);
});
