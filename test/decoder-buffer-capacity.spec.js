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
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0, decoderRespawn: 0 }
} } };
const logPath = require.resolve("../lib/Mirakurun/log");
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require("../lib/Mirakurun/_").default;
const TSDecoder = require("../lib/Mirakurun/TSDecoder").default;
const TSFilter = require("../lib/Mirakurun/TSFilter").default;
const turn = () => new Promise(resolve => setImmediate(resolve));
const OUTPUT_BYTES = 16 * 1024 * 1024;
const FILTER_BYTES = 8 * 1024 * 1024;

function fixture(t, depth) {
    _.config = { server: { maxBufferBytesBeforeReady: FILTER_BYTES } };
    const processes = [];
    t.mock.method(childProcess, "spawn", () => {
        const stdout = new PassThrough();
        // 復号処理だけをechoで置き換え、各Writableのqueue/HWMはNode自身に管理させる。
        const stdin = new Writable({ highWaterMark: 64 * 1024, write(chunk, _encoding, callback) { stdout.write(chunk); callback(); } });
        const proc = Object.assign(new EventEmitter(), { pid: processes.length + 1, stdin, stdout, stderr: new PassThrough() });
        proc.kill = t.mock.fn(() => { proc.stderr.end(); return true; });
        processes.push(proc);
        return proc;
    });
    let paused = true;
    let release;
    const received = [];
    const output = new Writable({ highWaterMark: OUTPUT_BYTES, write(chunk, _encoding, callback) {
        received.push(Buffer.from(chunk));
        if (paused) { release = callback; } else { callback(); }
    } });
    const decoders = [];
    let sink = output;
    for (let index = 0; index < depth; ++index) {
        sink = new TSDecoder({ command: "echo-decoder", output: sink });
        decoders.push(sink);
    }
    const filter = new TSFilter({ output: sink });
    t.after(() => {
        filter.close(false);
        for (const decoder of decoders) { decoder.close(false); }
        output.destroy();
        for (const proc of processes) { proc.stderr.unpipe(process.stderr); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
    });
    return { filter, sink, output, decoders, processes, received, resume() { paused = false; release?.(); } };
}
function inputTS() {
    const input = Buffer.alloc(188 * 96_000, 0x55);
    for (let pos = 0, cc = 0; pos < input.length; pos += 188, ++cc) {
        input[pos] = 0x47; input[pos + 1] = 1; input[pos + 2] = 0; input[pos + 3] = 0x10 | (cc & 15);
    }
    return input;
}
for (const depth of [0, 1, 2]) {
    it(`[decoder-buffer-capacity] 出力の16MiBを使ってからTSFilterへ保持し、再開後に欠落しない (decoders=${depth})`, async t => {
        const f = fixture(t, depth);
        const input = inputTS();
        for (let pos = 0; pos < input.length; pos += 188 * 100) { f.filter.write(input.subarray(pos, pos + 188 * 100)); }
        const outputBytes = f.output.writableLength;
        const filterBytes = f.filter._bufferBytes;
        f.resume(); await turn();
        f.filter.flush(); await turn();
        const actual = Buffer.concat(f.received);
        assert.equal(actual.length, input.length, "デコーダーの有無にかかわらず18,048,000Bを保持します");
        assert.deepEqual(actual, input);
        assert.ok(outputBytes >= OUTPUT_BYTES && outputBytes < OUTPUT_BYTES + 188 * 100);
        assert.ok(filterBytes > 0 && filterBytes <= FILTER_BYTES);
        assert.equal(f.filter._bufferBytes, 0);
        assert.equal(f.output.writableLength, 0);
        assert.equal(f.filter.streamInfo[0x100].drop, 0);
        assert.equal(f.filter.closed, false);
    });
}
it("[decoder-buffer-capacity] 入力queueの上限は出力容量と独立して背圧を返す", async t => {
    const f = fixture(t, 1);
    const decoder = f.decoders[0];
    decoder.cork();
    decoder.write(Buffer.alloc(64 * 1024));
    assert.equal(f.output.writableLength, 0);
    assert.equal(f.processes[0].stdin.writableLength, 0);
    assert.ok(decoder.writableLength >= decoder.writableHighWaterMark, "入力queueが自身の上限へ達したら上流を止めます");
    decoder.uncork(); await turn();
    assert.equal(f.output.writableLength, 64 * 1024);
    assert.ok(decoder.writableLength < decoder.writableHighWaterMark, "入力が解放された後は出力16MiBの余地を使います");
    f.resume(); await turn();
});
