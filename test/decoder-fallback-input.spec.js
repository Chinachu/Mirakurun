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
const { EventEmitter, once } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const prefix = fs.existsSync(path.join(__dirname, "../lib/server/modules/TSDecoder.js")) ? "server/modules" : "Mirakurun";
const status = { streamCount: { decoder: 0 }, errorCount: { decoderRespawn: 0 } };
for (const [name, exports] of [["status", { __esModule: true, default: status }], [prefix === "Mirakurun" ? "log" : "event-log", { info() {}, warn() {}, error() {}, debug() {} }]]) {
    const file = require.resolve(`../lib/${prefix}/${name}`);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const TSDecoder = require(`../lib/${prefix}/TSDecoder`).default;
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, passThroughOnFailure = true) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sent = []; const outputChunks = []; const releases = [];
    const stdin = new Writable({ highWaterMark: 8, write(chunk, _encoding, callback) { sent.push(Buffer.from(chunk)); releases.push(callback); } });
    const proc = Object.assign(new EventEmitter(), { pid: 1, stdin, stdout: new PassThrough(), stderr: new PassThrough() });
    proc.kill = t.mock.fn(() => { proc.stderr.end(); return true; });
    const spawn = t.mock.method(childProcess, "spawn", () => proc);
    const output = new Writable({ write(chunk, _encoding, callback) { outputChunks.push(Buffer.from(chunk)); callback(); } });
    const decoder = new TSDecoder({ command: "test-decoder", output, passThroughOnFailure, startupTimeout: 10_000 });
    decoder._deadCount = 3;
    t.after(() => { decoder.close(false); output.destroy(); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.unpipe(process.stderr); proc.stderr.destroy(); });
    return { decoder, output, outputChunks, proc, sent, releases, spawn };
}
for (const vector of [false, true]) {
    it(`[decoder-fallback-input] fallbackは旧stdinへ未送信の入力を順番に一度だけ引き継ぐ (vector=${vector})`, async t => {
        const f = fixture(t); let completed = 0;
        if (vector) { f.decoder.cork(); }
        for (let index = 1; index <= 10; ++index) { f.decoder.write(Buffer.alloc(8, index), () => ++completed); }
        if (vector) { f.decoder.uncork(); }
        assert.equal(f.proc.stdin.writableLength, 8); assert.equal(completed, 0);
        f.proc.emit("close", 1, null); await turn();
        assert.equal(completed, 10);
        assert.deepEqual(Buffer.concat(f.outputChunks), Buffer.concat(Array.from({ length: 9 }, (_, index) => Buffer.alloc(8, index + 2))));
        assert.deepEqual(f.sent.map(chunk => chunk[0]), [1], "既に旧stdinへ送った入力は再送しません");
        assert.equal(f.proc.stdin.listenerCount("drain"), 0);
        f.proc.stdin.emit("drain"); f.releases.shift()(); await turn();
        assert.equal(completed, 10); assert.equal(Buffer.concat(f.outputChunks).length, 72);
        f.decoder.write(Buffer.alloc(8, 11));
        assert.equal(Buffer.concat(f.outputChunks).at(-1), 11);
        t.mock.timers.tick(60_000); assert.equal(f.spawn.mock.callCount(), 1);
        f.decoder.end(); await turn();
        assert.equal(f.decoder._closed, true); assert.equal(f.output.writableEnded, true);
    });
}
it("[decoder-fallback-input] strictなTLV変換は残りを素通しせず一度だけ終了する", async t => {
    const f = fixture(t, false); let completed = 0;
    f.decoder.cork();
    for (let index = 1; index <= 10; ++index) { f.decoder.write(Buffer.alloc(8, index), () => ++completed); }
    f.decoder.uncork(); f.proc.emit("close", 1, null); await turn();
    assert.equal(completed, 10); assert.equal(f.decoder._closed, true);
    assert.equal(f.output.writableEnded, true); assert.equal(f.decoder._writable, undefined);
    assert.equal(f.outputChunks.length, 0); assert.equal(f.proc.stdin.listenerCount("drain"), 0);
    t.mock.timers.tick(60_000); assert.equal(f.spawn.mock.callCount(), 1);
});
for (const vector of [false, true]) {
    it(`[decoder-fallback-input] 実子プロセスのstdin待ちからのfallbackも未送信分を失わない (vector=${vector})`, { timeout: 15_000 }, async t => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-decoder-fallback-"));
        const script = path.join(dir, "stalled.cjs");
        fs.writeFileSync(script, 'process.stdout.write("started"); setInterval(() => {}, 1000);');
        const received = []; let firstOutput;
        const started = new Promise(resolve => { firstOutput = resolve; });
        const output = new Writable({ write(chunk, _encoding, callback) { received.push(Buffer.from(chunk)); firstOutput(); callback(); } });
        const decoder = new TSDecoder({ command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, withArgs: true, output, startupTimeout: 10_000 });
        const proc = decoder._process; const childClosed = once(proc, "close");
        t.after(async () => { decoder.close(false); output.destroy(); await childClosed; fs.rmSync(dir, { recursive: true, force: true }); });
        await decoder.waitForStart(); await started;
        const submitted = [];
        const write = proc.stdin.write.bind(proc.stdin);
        t.mock.method(proc.stdin, "write", (chunk, ...args) => { submitted.push(Buffer.from(chunk)); return write(chunk, ...args); });
        let sentOnFailure;
        const dead = decoder._dead.bind(decoder);
        t.mock.method(decoder, "_dead", (...args) => { if (sentOnFailure === undefined) { sentOnFailure = submitted.length; } return dead(...args); });
        decoder._deadCount = 3;
        const chunks = Array.from({ length: 32 }, (_, index) => Buffer.alloc(64 * 1024, index + 1));
        let completed = 0; let completedAll;
        const allCompleted = new Promise(resolve => { completedAll = resolve; });
        if (vector) { decoder.cork(); }
        for (const chunk of chunks) { decoder.write(chunk, () => { if (++completed === chunks.length) { completedAll(); } }); }
        if (vector) { decoder.uncork(); }
        assert.equal(typeof decoder._releaseInput, "function", "ネイティブstdinのdrain待ちを経由します");
        assert.ok(submitted.length < chunks.length);
        proc.kill("SIGTERM");
        await allCompleted; await childClosed; await turn();
        assert.ok(sentOnFailure > 0 && sentOnFailure < chunks.length, "失敗時に旧stdinへ未送信の入力があります");
        assert.equal(completed, chunks.length);
        const actual = Buffer.concat(received); const expected = Buffer.concat([Buffer.from("started"), ...chunks.slice(sentOnFailure)]);
        assert.equal(actual.length, expected.length);
        assert.ok(actual.equals(expected), "未送信分のバイト順と内容を保ちます");
        assert.equal(decoder._closed, false); assert.equal(decoder._process, undefined);
        assert.equal(proc.stdin.listenerCount("drain"), 0);
        decoder.end(); await turn();
        assert.equal(decoder._closed, true); assert.equal(output.writableEnded, true);
    });
}
