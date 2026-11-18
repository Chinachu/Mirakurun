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
const { EventEmitter, getEventListeners } = require("node:events");
const { PassThrough } = require("node:stream");
const childProcess = require("node:child_process");

const statusPath = require.resolve("../lib/Mirakurun/status");
const status = { streamCount: { decoder: 0 }, errorCount: { decoderRespawn: 0 } };
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: status } };
const log = require("../lib/Mirakurun/log");
const TSDecoder = require("../lib/Mirakurun/TSDecoder").default;

function makeProcess(t, started = true) {
    const proc = Object.assign(new EventEmitter(), {
        pid: started ? 4242 : undefined,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
    });
    const release = () => {
        proc.stderr.unpipe(process.stderr);
        for (const value of [proc.stdin, proc.stdout, proc.stderr]) { value.destroy(); }
    };
    proc.kill = t.mock.fn(() => { release(); return true; });
    t.after(release);
    return proc;
}

function installProcess(t, started = true) {
    for (const level of ["info", "debug", "warn", "error"]) { t.mock.method(log, level, () => {}); }
    const proc = makeProcess(t, started);
    const spawn = t.mock.method(childProcess, "spawn", () => proc);
    return { proc, spawn };
}

for (const code of ["ENOENT", "EACCES"]) {
    it(`TSDecoderは非同期${code}を開始処理へ返し、出力先の購読を保持する`, async t => {
        const { proc, spawn } = installProcess(t, false);
        const output = new PassThrough();
        const owner = () => {};
        for (const name of ["error", "finish", "close"]) { output.on(name, owner); }
        const count = status.streamCount.decoder;
        const decoder = new TSDecoder({ output, command: "test-decoder" });
        t.after(() => { decoder.close(false); output.destroy(); });
        const cause = Object.assign(new Error("startup failed"), { code });
        const start = decoder.waitForStart();
        proc.emit("error", cause);
        proc.emit("error", cause);
        proc.emit("close", -2, null);
        await assert.rejects(start, error => error.code === "ERR_DECODER_START_FAILED" && error.cause === cause);
        assert.equal(decoder._closed, true);
        assert.equal(decoder._deadCount, 0);
        assert.equal(output.writableEnded, false);
        assert.equal(status.streamCount.decoder, count);
        assert.equal(spawn.mock.callCount(), 1);
        for (const name of ["error", "finish", "close"]) { assert.deepEqual(output.listeners(name), [owner]); }
    });
}

it("TSDecoderは同期起動失敗でも出力先を終了せず、資源と自身の購読を解放する", t => {
    const { spawn } = installProcess(t);
    const cause = Object.assign(new Error("spawn failed"), { code: "EACCES" });
    spawn.mock.mockImplementation(() => { throw cause; });
    const output = new PassThrough();
    t.after(() => output.destroy());
    const owner = () => {};
    output.on("finish", owner);
    const count = status.streamCount.decoder;
    assert.throws(() => new TSDecoder({ output, command: "test-decoder" }), error => error.code === "ERR_DECODER_START_FAILED" && error.cause === cause);
    assert.equal(status.streamCount.decoder, count);
    assert.equal(output.writableEnded, false);
    assert.deepEqual(output.listeners("finish"), [owner]);
    assert.equal(output.listenerCount("close"), 0);
});

it("TSDecoderの開始待機はspawnを待ち、abort後の購読を残さない", async t => {
    const { proc } = installProcess(t, false);
    const output = new PassThrough();
    const decoder = new TSDecoder({ output, command: "test-decoder" });
    t.after(() => { decoder.close(false); output.destroy(); });
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const cancelled = decoder.waitForStart(controller.signal);
    controller.abort(reason);
    await assert.rejects(cancelled, error => error === reason);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    let resolved = false;
    const start = decoder.waitForStart().then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false);
    proc.emit("spawn");
    await start;
    assert.equal(resolved, true);
});

it("TSDecoderは起動後や終了後に複数回届くプロセス操作エラーを捕捉する", async t => {
    const { proc } = installProcess(t);
    const output = new PassThrough();
    const decoder = new TSDecoder({ output, command: "test-decoder" });
    t.after(() => { decoder.close(false); output.destroy(); });
    await decoder.waitForStart();
    for (let i = 0; i < 2; ++i) {
        assert.doesNotThrow(() => proc.emit("error", Object.assign(new Error("operation failed"), { code: "ESRCH" })));
    }
    assert.equal(decoder._deadCount, 0);
    assert.equal(output.writableEnded, false);
    decoder.close(false);
    assert.doesNotThrow(() => proc.emit("error", Object.assign(new Error("late error"), { code: "ESRCH" })));
});

for (const passThroughOnFailure of [false, true]) {
    it(`TSDecoderの退役stdoutは出力を再開しない (passThroughOnFailure=${passThroughOnFailure})`, async t => {
        const { proc, spawn } = installProcess(t);
        const output = new PassThrough();
        const errors = [];
        output.on("error", error => errors.push(error));
        const writes = t.mock.method(output, "write");
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const decoder = new TSDecoder({ output, command: "test-decoder", passThroughOnFailure });
        t.after(() => { decoder.close(false); output.destroy(); });
        await decoder.waitForStart();
        const processes = [proc];
        spawn.mock.mockImplementation(() => {
            const replacement = makeProcess(t);
            processes.push(replacement);
            return replacement;
        });
        for (let attempt = 0; attempt < 4; ++attempt) {
            const current = processes.at(-1);
            const pendingData = current.stdout.listeners("data");
            current.stdin.emit("error", Object.assign(new Error("closed stdin"), { code: "EPIPE" }));
            assert.equal(current.stdout.listenerCount("data"), 0);
            for (const listener of pendingData) { listener(Buffer.from("late decoded")); }
            current.stdout.emit("data", Buffer.from("later decoded"));
            assert.equal(writes.mock.callCount(), 0);
            if (attempt < 3) { t.mock.timers.tick(1500); await decoder.waitForStart(); }
        }
        assert.equal(output.writableEnded, !passThroughOnFailure);
        if (passThroughOnFailure) {
            decoder.write(Buffer.from("raw fallback"));
            assert.equal(writes.mock.callCount(), 1);
        }
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(errors, []);
    });
}

it("TSDecoderは出力先の終了後に届くstdoutを捨てる", async t => {
    const { proc } = installProcess(t);
    const output = new PassThrough();
    const writes = t.mock.method(output, "write");
    const decoder = new TSDecoder({ output, command: "test-decoder" });
    t.after(() => { decoder.close(false); output.destroy(); });
    await decoder.waitForStart();
    const pendingData = proc.stdout.listeners("data");
    output.end();
    for (const listener of pendingData) { listener(Buffer.from("late decoded")); }
    assert.equal(writes.mock.callCount(), 0);
});

it("TSDecoderは再起動待ちの終了時にtimerを解放する", async t => {
    const { proc, spawn } = installProcess(t);
    const output = new PassThrough();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const decoder = new TSDecoder({ output, command: "test-decoder" });
    t.after(() => { decoder.close(false); output.destroy(); });
    await decoder.waitForStart();
    proc.stdin.emit("error", new Error("closed stdin"));
    assert.equal(decoder._deadCount, 1);
    decoder.close(false);
    assert.equal(decoder._respawnTimeout, undefined);
    t.mock.timers.runAll();
    assert.equal(spawn.mock.callCount(), 1);
});

for (const synchronous of [false, true]) {
    it(`TSDecoderは再起動失敗を有限再試行へ渡す (synchronous=${synchronous})`, async t => {
        const { proc, spawn } = installProcess(t);
        const output = new PassThrough();
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const decoder = new TSDecoder({ output, command: "test-decoder", passThroughOnFailure: false });
        t.after(() => { decoder.close(false); output.destroy(); });
        await decoder.waitForStart();
        proc.stdin.emit("error", new Error("closed stdin"));
        const cause = Object.assign(new Error("respawn failed"), { code: "ENOENT" });
        const replacements = [];
        spawn.mock.mockImplementation(() => {
            if (synchronous) { throw cause; }
            const replacement = makeProcess(t, false);
            replacements.push(replacement);
            return replacement;
        });
        for (let attempt = 0; attempt < 3; ++attempt) {
            t.mock.timers.tick(1500);
            const start = decoder.waitForStart();
            if (!synchronous) {
                replacements.at(-1).emit("error", cause);
                replacements.at(-1).emit("close", -2, null);
            }
            await assert.rejects(start, error => error.code === "ERR_DECODER_START_FAILED" && error.cause === cause);
        }
        assert.equal(output.writableEnded, true);
        assert.equal(spawn.mock.callCount(), 4);
        assert.equal(decoder._deadCount, 4);
    });
}
