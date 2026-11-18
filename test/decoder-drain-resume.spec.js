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
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const childProcess = require("node:child_process");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0, decoderRespawn: 0 }
} } };
const logPath = require.resolve("../lib/Mirakurun/log");
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require("../lib/Mirakurun/_").default;
const TSDecoder = require("../lib/Mirakurun/TSDecoder").default;
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
const turn = () => new Promise(resolve => setImmediate(resolve));
// 未同期の最初の候補も、次のTLVヘッダーで境界を確認できるよう2パケットずつ渡す。
const packet = marker => Buffer.from([0x7F, 0xFF, 0, 4, marker, marker, marker, marker,
    0x7F, 0xFF, 0, 4, marker, marker, marker, marker]);

function fixture(t, { depth = 1, holdInput = true, holdOutput = false, holdFinal = false } = {}) {
    const previousConfig = _.config;
    _.config = { server: { maxBufferBytesBeforeReady: 4096 } };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const processes = [];
    const received = [];
    const outputReleases = [];
    let outputBlocked = holdOutput;
    let finishOutput;
    const outsideDrain = t.mock.fn();
    const output = new Writable({ highWaterMark: holdOutput ? 8 : 1024 * 1024, write(chunk, _encoding, callback) {
        received.push(Buffer.from(chunk));
        if (outputBlocked) { outputReleases.push(callback); } else { callback(); }
    }, final(callback) { if (holdFinal) { finishOutput = callback; } else { callback(); } } });
    output.on("drain", outsideDrain);
    t.mock.method(childProcess, "spawn", () => {
        const index = processes.length;
        const stdout = new PassThrough();
        const writes = [];
        const releases = [];
        const stdin = new Writable({ highWaterMark: 8, write(chunk, _encoding, callback) {
            writes.push(Buffer.from(chunk));
            stdout.write(chunk);
            if (holdInput && index % depth === 0) { releases.push(callback); } else { callback(); }
        } });
        const proc = Object.assign(new EventEmitter(), { pid: index + 1, stdin, stdout, stderr: new PassThrough(), writes, releases });
        proc.kill = t.mock.fn(() => { proc.stderr.end(); return true; });
        processes.push(proc);
        return proc;
    });
    const decoders = [];
    let sink = output;
    for (let index = 0; index < depth; ++index) {
        sink = new TSDecoder({ command: "test-decoder", output: sink, startupTimeout: 30_000 });
        decoders.push(sink);
    }
    const filter = new TLVFilter({ output: sink });
    t.after(() => {
        filter.close(false);
        for (const decoder of [...decoders].reverse()) { decoder.close(false); }
        output.destroy();
        for (const proc of processes) { proc.stderr.unpipe(process.stderr); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
        _.config = previousConfig;
    });
    return { processes, output, outputReleases, decoders, filter, sink, received, outsideDrain,
        resumeOutput() { outputBlocked = false; outputReleases.shift()?.(); },
        finishOutput() { finishOutput?.(); } };
}

for (const depth of [1, 2]) {
    for (const blocked of ["stdin", "output"]) {
        it(`[decoder-drain-resume] ${blocked}の空きでTLVの保留分を再開し、追加入力を待たない (decoders=${depth})`, async t => {
            const f = fixture(t, { depth, holdInput: blocked === "stdin", holdOutput: blocked === "output" });
            const first = packet(1); const second = packet(2);
            f.filter.write(first); await turn();
            assert.equal(f.sink.writableNeedDrain, false, "decoder自身の入力はHWM未満です");
            assert.ok(f.sink.writableLength >= f.sink.writableHighWaterMark);
            f.filter.write(second);
            assert.equal(f.filter._bufferBytes, second.length);
            assert.deepEqual(Buffer.concat(f.received), first);
            if (blocked === "stdin") { f.processes[0].releases.shift()(); }
            else { f.resumeOutput(); }
            await turn();
            assert.equal(f.filter._bufferBytes, 0, "flushやwriteを追加せずdrainで保留分を渡します");
            assert.deepEqual(Buffer.concat(f.received), Buffer.concat([first, second]));
            f.processes[0].releases.shift()?.(); await turn();
            assert.equal(f.filter.closed, false);
        });
    }
    it(`[decoder-drain-resume] stdinだけ空いても出力が満杯なら再開しない (decoders=${depth})`, async t => {
        const f = fixture(t, { depth, holdInput: true, holdOutput: true });
        f.filter.write(packet(1)); await turn();
        f.filter.write(packet(2));
        const drain = t.mock.fn(); f.sink.on("drain", drain);
        f.processes[0].releases.shift()(); await turn();
        assert.equal(f.filter._bufferBytes, 16); assert.equal(drain.mock.callCount(), 0);
        f.resumeOutput(); await turn();
        assert.equal(f.filter._bufferBytes, 0); assert.equal(drain.mock.callCount(), 1);
        assert.deepEqual(Buffer.concat(f.received), Buffer.concat([packet(1), packet(2)]));
        f.processes[0].releases.shift()?.(); await turn();
    });
}

it("[decoder-drain-resume] Node本来の入力drainが発生するときは二重に通知しない", async t => {
    const f = fixture(t);
    const drain = t.mock.fn(); f.sink.on("drain", drain);
    assert.equal(f.sink.write(Buffer.alloc(128 * 1024)), false);
    assert.ok(f.sink.writableLength >= f.sink.writableHighWaterMark);
    assert.equal(f.sink.writableNeedDrain, true);
    f.processes[0].releases.shift()(); await turn();
    assert.equal(drain.mock.callCount(), 1);
    assert.equal(f.sink.writableLength, 0);
});
it("[decoder-drain-resume] 満杯を通知していない出力のdrainを上流へ重ねて送らない", async t => {
    const f = fixture(t, { holdInput: false });
    const drain = t.mock.fn(); f.sink.on("drain", drain);
    f.sink.write(Buffer.alloc(4));
    assert.ok(f.sink.writableLength < f.sink.writableHighWaterMark);
    f.output.emit("drain"); await turn();
    assert.equal(drain.mock.callCount(), 0);
});
for (const endOutput of [false, true]) {
    it(`[decoder-drain-resume] 空き通知を待つ間のcloseは通知と自分の購読を解除する (endOutput=${endOutput})`, async t => {
        const f = fixture(t);
        f.sink.write(packet(1));
        assert.ok(f.sink.writableLength >= f.sink.writableHighWaterMark);
        const drain = t.mock.fn(); f.sink.on("drain", drain);
        f.processes[0].releases.shift()();
        f.sink.close(endOutput); await turn();
        assert.equal(drain.mock.callCount(), 0);
        assert.equal(f.output.listenerCount("drain"), 1, "出力所有者の購読だけを残します");
        assert.equal(f.output.listeners("drain")[0], f.outsideDrain);
        f.output.emit("drain"); await turn();
        assert.equal(drain.mock.callCount(), 0); assert.equal(f.outsideDrain.mock.callCount(), 1);
        assert.equal(f.output.writableEnded, endOutput);
    });
}
for (const fallback of [false, true]) {
    it(`[decoder-drain-resume] ${fallback ? "fallback" : "再起動"}後も保留分を退役した子へ再送せず再開する`, async t => {
        const f = fixture(t);
        f.filter.write(packet(1)); await turn();
        f.filter.write(packet(2));
        assert.equal(f.filter._bufferBytes, 16);
        const previous = f.processes[0];
        if (fallback) { f.sink._deadCount = 3; }
        previous.emit("close", 1, null); await turn();
        if (!fallback) {
            assert.equal(f.filter._bufferBytes, 16, "再起動先がない間は保留分を破棄しません");
            t.mock.timers.tick(1500); await turn();
        }
        assert.equal(f.filter._bufferBytes, 0);
        assert.deepEqual(Buffer.concat(f.received), Buffer.concat([packet(1), packet(2)]));
        assert.deepEqual(Buffer.concat(previous.writes), packet(1));
        previous.stdin.emit("drain"); await turn();
        assert.deepEqual(Buffer.concat(f.received), Buffer.concat([packet(1), packet(2)]));
        f.processes[1]?.releases.shift()?.(); await turn();
    });
}

it("[decoder-drain-resume] 空きを観測した同じ呼出しの後から購読しても再開通知を失わない", async t => {
    const f = fixture(t);
    f.sink.write(packet(1));
    assert.ok(f.sink.writableLength >= f.sink.writableHighWaterMark);
    f.processes[0].releases.shift()();
    const drain = t.mock.fn(); f.sink.on("drain", drain);
    assert.equal(drain.mock.callCount(), 0, "write callbackの途中に同期再入しません");
    await turn();
    assert.equal(drain.mock.callCount(), 1);
});
for (const action of ["end", "destroy"]) {
    it(`[decoder-drain-resume] 出力先の${action}からclose通知までの間も再開通知を送らない`, async t => {
        const f = fixture(t, { holdFinal: action === "end" });
        f.sink.write(packet(1));
        assert.ok(f.sink.writableLength >= f.sink.writableHighWaterMark);
        const drain = t.mock.fn(); f.sink.on("drain", drain);
        f.processes[0].releases.shift()();
        f.output[action]();
        if (action === "end") {
            assert.equal(f.output.writableEnded, true);
            assert.equal(f.output.writableFinished, false);
            assert.equal(f.sink._closed, false, "下流のfinal完了前なのでfinish/close通知はまだ届きません");
        }
        await turn();
        assert.equal(drain.mock.callCount(), 0);
        if (action === "end") {
            assert.equal(f.sink._closed, false);
            f.finishOutput(); await turn();
            assert.equal(f.sink._closed, true);
        }
    });
}
