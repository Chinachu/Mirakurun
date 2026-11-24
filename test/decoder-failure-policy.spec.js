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
const { PassThrough, Writable } = require("node:stream");
const childProcess = require("node:child_process");
const status = { streamCount: { decoder: 0 }, errorCount: { decoderRespawn: 0 } };
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: status } };
const logPath = require.resolve("../lib/Mirakurun/log");
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const TSDecoder = require("../lib/Mirakurun/TSDecoder").default;
function fixture(t, passThroughOnFailure) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const processes = [];
    const spawn = t.mock.method(childProcess, "spawn", () => {
        const proc = Object.assign(new EventEmitter(), { pid: processes.length + 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        proc.kill = t.mock.fn(() => { proc.stderr.end(); return true; });
        processes.push(proc); return proc;
    });
    const written = [];
    const output = new Writable({ write(chunk, _encoding, callback) { written.push(Buffer.from(chunk)); callback(); } });
    const count = status.streamCount.decoder;
    const decoder = new TSDecoder({ command: "test-decoder", output, passThroughOnFailure });
    t.after(() => {
        decoder.close(false); output.destroy();
        for (const proc of processes) { proc.stderr.unpipe(process.stderr); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
        assert.equal(status.streamCount.decoder, count);
    });
    return { decoder, processes, spawn, output, written, count };
}
function assertTerminal(f, passThroughOnFailure = true) {
    assert.equal(f.decoder._process, undefined);
    assert.equal(f.decoder._deadCount, 4);
    assert.equal(f.decoder._closed, !passThroughOnFailure);
    assert.equal(f.output.writableEnded, !passThroughOnFailure);
    if (passThroughOnFailure) {
        f.decoder.write(Buffer.from("fallback"));
        assert.deepEqual(Buffer.concat(f.written), Buffer.from("fallback"));
    } else { assert.equal(f.written.length, 0); }
}
for (const passThrough of [undefined, true, false]) {
    it(`[decoder-failure-policy.spec] 無出力timeoutは35669ceと同じ2回・4500msまで再試行する (passThrough=${passThrough})`, t => {
        const f = fixture(t, passThrough);
        const attempts = 2;
        const weight = 2;
        let elapsed = 0;
        for (let index = 0; index < attempts; ++index) {
            assert.equal(f.spawn.mock.callCount(), index + 1);
            f.decoder.write(Buffer.from("input"));
            t.mock.timers.tick(1499); elapsed += 1499;
            assert.equal(f.processes[index].kill.mock.callCount(), 0);
            assert.equal(f.decoder._closed, false);
            t.mock.timers.tick(1); ++elapsed;
            assert.equal(f.processes[index].kill.mock.callCount(), 1);
            assert.equal(f.decoder._deadCount, (index + 1) * weight);
            f.processes[index].emit("close", null, "SIGKILL");
            assert.equal(f.decoder._deadCount, (index + 1) * weight, "同じ子の終了通知で重みを追加しません");
            if (index + 1 < attempts) {
                t.mock.timers.tick(1499); elapsed += 1499;
                assert.equal(f.spawn.mock.callCount(), index + 1);
                t.mock.timers.tick(1); ++elapsed;
            }
        }
        assert.equal(elapsed, 4500);
        assertTerminal(f, passThrough);
        t.mock.timers.tick(60_000);
        assert.equal(f.spawn.mock.callCount(), attempts, "上限後に再起動しません");
    });
    it(`[decoder-failure-policy.spec] 通常の子の異常終了は4回で上限となる (passThrough=${passThrough})`, t => {
        const f = fixture(t, passThrough);
        for (let index = 0; index < 4; ++index) {
            assert.equal(f.spawn.mock.callCount(), index + 1);
            f.processes[index].stderr.end();
            f.processes[index].emit("close", 1, null);
            assert.equal(f.decoder._deadCount, index + 1);
            if (index < 3) {
                assert.equal(f.decoder._closed, false);
                t.mock.timers.tick(1500);
            }
        }
        assertTerminal(f, passThrough);
        t.mock.timers.tick(60_000);
        assert.equal(f.spawn.mock.callCount(), 4);
    });
}
for (const mode of ["sync", "async"]) {
    it(`[decoder-failure-policy.spec] 初回の起動失敗はtimeout予算へ入れず出力先を残す (${mode})`, async t => {
        const f = fixture(t, false);
        f.decoder.close(false);
        const cause = Object.assign(new Error("start failed"), { code: "ENOENT" });
        if (mode === "sync") {
            f.spawn.mock.mockImplementation(() => { throw cause; });
            assert.throws(() => new TSDecoder({ output: f.output, command: "test-decoder", passThroughOnFailure: false }), error => error.code === "ERR_DECODER_START_FAILED" && error.cause === cause);
        } else {
            f.spawn.mock.mockImplementation(() => {
                const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
                f.processes.push(proc); return proc;
            });
            const decoder = new TSDecoder({ output: f.output, command: "test-decoder", passThroughOnFailure: false });
            t.after(() => decoder.close(false));
            const failed = assert.rejects(decoder.waitForStart(), error => error.code === "ERR_DECODER_START_FAILED" && error.cause === cause);
            f.processes.at(-1).emit("error", cause);
            await failed;
            assert.equal(decoder._deadCount, 0);
            assert.equal(decoder._closed, true);
        }
        assert.equal(f.output.writableEnded, false);
        t.mock.timers.tick(60_000);
        assert.equal(f.spawn.mock.callCount(), 2);
    });
}
