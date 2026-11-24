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
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Readable, Writable } = require("node:stream");
const childProcess = require("node:child_process");
const status = { streamCount: { decoder: 0 }, errorCount: { decoderRespawn: 0 } };
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: status } };
const logPath = require.resolve("../lib/Mirakurun/log");
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const TSDecoder = require("../lib/Mirakurun/TSDecoder").default;
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, passThroughOnFailure = false) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const processes = [];
    t.mock.method(childProcess, "spawn", () => {
        const writes = [];
        const releases = [];
        const stdin = new Writable({ highWaterMark: 8, write(chunk, _encoding, callback) { writes.push(Buffer.from(chunk)); releases.push(callback); } });
        const proc = Object.assign(new EventEmitter(), { pid: processes.length + 1, stdin, stdout: new PassThrough(), stderr: new PassThrough(), writes, releases });
        proc.kill = t.mock.fn(() => { proc.stderr.end(); return true; });
        processes.push(proc); return proc;
    });
    const output = new Writable({ highWaterMark: 32, write(_chunk, _encoding, callback) { callback(); } });
    const decoder = new TSDecoder({ command: "test-decoder", output, passThroughOnFailure, startupTimeout: 10_000 });
    t.after(() => {
        decoder.close(false); output.destroy();
        for (const proc of processes) { proc.stderr.unpipe(process.stderr); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
    });
    return { decoder, output, processes };
}
it("[decoder-input-backpressure] stdinが詰まると上流へ背圧を返し、drain後だけ次の入力を渡す", async t => {
    const f = fixture(t); const proc = f.processes[0];
    let completed = 0;
    assert.equal(f.decoder.write(Buffer.alloc(8, 1), () => ++completed), true);
    f.decoder.write(Buffer.alloc(8, 2), () => ++completed);
    assert.deepEqual(proc.writes.map(chunk => chunk[0]), [1]);
    assert.equal(completed, 0);
    assert.equal(f.decoder.writableHighWaterMark, f.output.writableHighWaterMark);
    assert.ok(f.decoder.writableLength >= f.decoder.writableHighWaterMark, "filterのflushもstdinの詰まりを検出します");
    proc.releases.shift()(); await turn();
    assert.deepEqual(proc.writes.map(chunk => chunk[0]), [1, 2]);
    assert.equal(completed, 1);
    proc.releases.shift()(); await turn();
    assert.equal(completed, 2); assert.equal(f.decoder.writableLength, 0);
});
it("[decoder-input-backpressure] corkしたvectorもstdinの上限で待ち、再開後のバイト順を保つ", async t => {
    const f = fixture(t); const proc = f.processes[0];
    let completed = 0;
    f.decoder.cork();
    for (let index = 1; index <= 100; ++index) { f.decoder.write(Buffer.alloc(4, index), () => ++completed); }
    f.decoder.uncork();
    assert.equal(proc.stdin.writableLength, 8, "最初のdrain前に全vectorを子へ押し込みません");
    assert.ok(f.decoder.writableLength >= f.decoder.writableHighWaterMark, "stdinの詰まりを出力と同じ単位で公開します");
    for (let index = 0; index < 100; ++index) { assert.ok(proc.releases.length > 0); proc.releases.shift()(); await turn(); }
    assert.deepEqual(proc.writes.map(chunk => chunk[0]), Array.from({ length: 100 }, (_, index) => index + 1));
    assert.equal(completed, 100); assert.equal(proc.stdin.writableLength, 0); assert.equal(f.decoder.writableLength, 0);
});
for (const mode of ["close", "child-close", "stdin-error", "timeout"]) {
    it(`[decoder-input-backpressure] ${mode}はdrain待ちとqueued callbackを一度だけ解放し、古いdrainで再送しない`, async t => {
        const f = fixture(t); const proc = f.processes[0];
        let completed = 0;
        f.decoder.write(Buffer.alloc(8, 1), () => ++completed);
        f.decoder.write(Buffer.alloc(8, 2), () => ++completed);
        assert.equal(proc.stdin.listenerCount("drain"), 1);
        if (mode === "close") { f.decoder.close(false); }
        if (mode === "child-close") { proc.emit("close", 1, null); }
        if (mode === "stdin-error") { proc.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })); }
        if (mode === "timeout") { t.mock.timers.tick(10_000); }
        await turn();
        assert.equal(completed, 2); assert.equal(proc.stdin.listenerCount("drain"), 0);
        proc.stdin.emit("drain");
        proc.releases.shift()?.(); await turn();
        assert.equal(completed, 2); assert.deepEqual(proc.writes.map(chunk => chunk[0]), [1]);
        if (mode !== "close") {
            t.mock.timers.tick(1500);
            assert.equal(f.processes.length, 2);
            f.decoder.write(Buffer.alloc(8, 3), () => ++completed);
            const next = f.processes[1];
            proc.stdin.emit("drain"); await turn();
            assert.equal(completed, 2); assert.deepEqual(next.writes.map(chunk => chunk[0]), [3]);
            next.releases.shift()(); await turn(); assert.equal(completed, 3);
        }
    });
}
it("[decoder-input-backpressure] 出力先の背圧も公開し、stdinが空でも上流のflushを止める", t => {
    const f = fixture(t);
    const release = [];
    const output = new Writable({ highWaterMark: 4, write(_chunk, _encoding, callback) { release.push(callback); } });
    f.decoder.close(false);
    const decoder = new TSDecoder({ command: "test-decoder", output });
    t.after(() => { decoder.close(false); output.destroy(); });
    f.processes.at(-1).stdout.emit("data", Buffer.alloc(16));
    assert.equal(decoder.writableHighWaterMark, 4);
    assert.ok(decoder.writableLength >= 16);
    release.shift()();
    assert.equal(decoder.writableLength, 0);
});
it("[decoder-input-backpressure] pipeした上流もstdinが詰まると停止し、入力を蓄積し続けない", async t => {
    const f = fixture(t); const proc = f.processes[0];
    let count = 0;
    const input = new Readable({ read() { if (count < 100) { this.push(Buffer.alloc(64 * 1024, ++count)); } else { this.push(null); } } });
    t.after(() => { input.unpipe(f.decoder); input.destroy(); });
    input.pipe(f.decoder);
    await turn();
    assert.equal(proc.writes.length, 1);
    assert.equal(proc.stdin.writableLength, 64 * 1024);
    assert.equal(f.decoder.writableNeedDrain, true);
    assert.equal(input.isPaused(), true);
    assert.ok(count <= 2, "上流は100チャンクを読み続けません");
    proc.releases.shift()(); await turn();
    assert.equal(proc.writes.length, 2);
    assert.equal(input.isPaused(), true);
    assert.ok(count <= 3);
});
it("[decoder-input-backpressure] vectorのdrain待ち中のcloseも全callbackを解放し、残りを別のstdinへ送らない", async t => {
    const f = fixture(t); const proc = f.processes[0];
    let completed = 0;
    f.decoder.cork();
    for (let index = 0; index < 100; ++index) { f.decoder.write(Buffer.alloc(4, index), () => ++completed); }
    f.decoder.uncork();
    assert.equal(proc.stdin.writableLength, 8);
    assert.equal(proc.writes.length, 1);
    f.decoder.close(false); await turn();
    assert.equal(completed, 100);
    assert.equal(proc.stdin.listenerCount("drain"), 0);
    proc.stdin.emit("drain"); proc.releases.shift()(); await turn();
    assert.equal(completed, 100); assert.equal(proc.writes.length, 1);
    assert.equal(f.output.writableEnded, false);
});
for (const passThrough of [false, true]) {
    it(`[decoder-input-backpressure] end待ち中の子の終了はstreamを閉じ、再起動やfallbackを残さない (passThrough=${passThrough})`, async t => {
        const f = fixture(t, passThrough); const proc = f.processes[0];
        f.decoder._deadCount = 3;
        let completed = 0;
        f.decoder.write(Buffer.alloc(8, 1), () => ++completed);
        f.decoder.end();
        assert.equal(completed, 0);
        proc.emit("close", 1, null); await turn();
        assert.equal(completed, 1);
        assert.equal(f.decoder._closed, true); assert.equal(f.output.writableEnded, true);
        assert.equal(f.decoder._writable, undefined);
        t.mock.timers.tick(60_000);
        assert.equal(f.processes.length, 1); assert.equal(f.decoder._respawnTimeout, undefined);
        assert.equal(proc.stdin.listenerCount("drain"), 0);
    });
}

for (const vector of [false, true]) {
    it(`[decoder-input-backpressure] 初回出力後に生きた子がstdinを読まなくてもendから5秒で終了する (vector=${vector})`, async t => {
        const f = fixture(t); const proc = f.processes[0];
        const onClose = t.mock.fn(); const onEnd = t.mock.fn(); const onOutputClose = t.mock.fn();
        f.decoder.on("close", onClose); f.decoder.on("end", onEnd); f.output.on("close", onOutputClose);
        let completed = 0;
        if (vector) { f.decoder.cork(); }
        for (let index = 1; index <= 20; ++index) { f.decoder.write(Buffer.alloc(8, index), () => ++completed); }
        if (vector) { f.decoder.uncork(); }
        proc.stdout.emit("data", Buffer.from("first-output"));
        t.mock.timers.tick(20_000);
        assert.equal(proc.kill.mock.callCount(), 0, "初回出力で起動監視は解除されています");
        assert.equal(f.decoder.end(), f.decoder);
        t.mock.timers.tick(4999); await turn();
        assert.equal(f.decoder._closed, false);
        t.mock.timers.tick(1); await turn();
        assert.equal(f.decoder._closed, true);
        assert.equal(f.output.writableEnded, true); assert.equal(f.output.closed, true);
        assert.equal(proc.kill.mock.callCount(), 1); assert.deepEqual(proc.kill.mock.calls[0].arguments, ["SIGKILL"]);
        assert.equal(completed, 20); assert.equal(onClose.mock.callCount(), 1); assert.equal(onEnd.mock.callCount(), 1);
        assert.equal(onOutputClose.mock.callCount(), 1, "出力所有者の購読も残します");
        assert.equal(proc.stdin.listenerCount("drain"), 0);
        proc.stdin.emit("drain"); proc.releases.shift()?.(); t.mock.timers.tick(60_000); await turn();
        assert.equal(completed, 20); assert.equal(f.processes.length, 1); assert.equal(proc.kill.mock.callCount(), 1);
        assert.equal(f.decoder._endTimeout, undefined); assert.equal(f.decoder._respawnTimeout, undefined);
        assert.deepEqual(proc.writes.map(chunk => chunk[0]), [1]);
    });
}
it("[decoder-input-backpressure] endを重ねても終了期限を延長しない", async t => {
    const f = fixture(t); const proc = f.processes[0];
    f.decoder.write(Buffer.alloc(8)); proc.stdout.emit("data", Buffer.from("started"));
    f.decoder.end(); t.mock.timers.tick(4000); f.decoder.end(); t.mock.timers.tick(999);
    assert.equal(f.decoder._closed, false);
    t.mock.timers.tick(1); await turn();
    assert.equal(f.decoder._closed, true); assert.equal(proc.kill.mock.callCount(), 1);
});
it("[decoder-input-backpressure] 期限内のdrainはend前の入力順を保ち、終了timerを残さない", async t => {
    const f = fixture(t); const proc = f.processes[0];
    let completed = 0;
    f.decoder.write(Buffer.alloc(8, 1), () => ++completed);
    proc.stdout.emit("data", Buffer.from("started"));
    f.decoder.end(Buffer.alloc(8, 2));
    t.mock.timers.tick(4999);
    proc.releases.shift()(); await turn();
    assert.equal(f.decoder._closed, false); assert.equal(completed, 1);
    proc.releases.shift()(); await turn();
    assert.deepEqual(proc.writes.map(chunk => chunk[0]), [1, 2]);
    assert.equal(f.decoder._closed, true); assert.equal(f.decoder._endTimeout, undefined);
    t.mock.timers.tick(60_000); assert.equal(proc.kill.mock.callCount(), 1); assert.equal(f.processes.length, 1);
});
for (const mode of ["close-without-output", "output-close", "no-input"]) {
    it(`[decoder-input-backpressure] ${mode}でも終了timerを解除し、二重解放しない`, async t => {
        const f = fixture(t); const proc = f.processes[0];
        if (mode !== "no-input") {
            f.decoder.write(Buffer.alloc(8)); proc.stdout.emit("data", Buffer.from("started")); f.decoder.end();
            if (mode === "close-without-output") { f.decoder.close(false); }
            else { f.output.destroy(); }
        } else { f.decoder.end(); }
        await turn();
        assert.equal(f.decoder._closed, true); assert.equal(f.decoder._endTimeout, undefined);
        assert.equal(f.output.writableEnded, mode !== "close-without-output");
        t.mock.timers.tick(60_000); await turn();
        assert.equal(proc.kill.mock.callCount(), 1); assert.equal(f.processes.length, 1);
    });
}

it("[decoder-input-backpressure] 不正なend引数で拒否された要求は稼働中の子を終了させない", async t => {
    const f = fixture(t); const proc = f.processes[0];
    f.decoder.write(Buffer.alloc(8)); proc.stdout.emit("data", Buffer.from("started"));
    assert.throws(() => f.decoder.end(3), { code: "ERR_INVALID_ARG_TYPE" });
    assert.equal(f.decoder.writableEnded, false);
    t.mock.timers.tick(20_000); await turn();
    assert.equal(proc.kill.mock.callCount(), 0); assert.equal(f.decoder._closed, false);
    assert.equal(f.decoder._endTimeout, undefined);
    f.decoder.end(); t.mock.timers.tick(5000); await turn();
    assert.equal(f.decoder._closed, true); assert.equal(proc.kill.mock.callCount(), 1);
});
