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
require("reflect-metadata");
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");
const { TsCrc32 } = require("@chinachu/aribts");
const feature = fs.existsSync(path.join(__dirname, "../src/Mirakurun"));
const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
const statusPath = require.resolve(prefix + "/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0 }, errorCount: { bufferOverflow: 0 }
} } };
const logPath = require.resolve(prefix + (feature ? "/log" : "/event-log"));
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require(prefix + "/_").default;
const TSFilter = require(prefix + "/TSFilter").default;
function header(cc = 0) {
    const p = Buffer.alloc(188, 0xFF);
    p.set([0x47, 0, 0x2F, 0x10 | cc & 15]);
    const payload = p.subarray(4); payload.set([0x1A, 0x86, 0]);
    for (let slot = 0; slot < 52; ++slot) {
        const relTs = slot < 26 ? 1 : 2;
        const offset = 69 + (slot >> 1);
        payload[offset] = slot & 1 ? payload[offset] & 0xF0 | relTs : relTs << 4 | payload[offset] & 15;
    }
    payload.writeUInt32BE(TsCrc32.calc(payload.subarray(0, 180)) >>> 0, 180);
    assert.equal(TsCrc32.calc(payload), 0);
    return p;
}
function frame(marker = 0) {
    return Array.from({ length: 52 }, (_, slot) => {
        const p = Buffer.alloc(188, marker + slot + 1);
        const pid = slot < 26 ? 0x100 : 0x200;
        p.set([0x47, pid >> 8, pid & 255, 0x10 | slot & 15]); return p;
    });
}
function fixture(t, outputOptions = {}) {
    const config = _.config; _.config = { server: {} };
    const written = [];
    const output = new Writable({ ...outputOptions, write(chunk, _encoding, done) { written.push(Buffer.from(chunk)); done(); } });
    const filter = new TSFilter({ output, tsmfRelTs: 1 });
    t.after(() => { filter.close(false); output.destroy(); _.config = config; });
    return { filter, output, written };
}
function write(filter, packets, size = 1e9, defer = false) {
    const input = Buffer.concat(packets);
    for (let pos = 0; pos < input.length; pos += size) { filter.write(input.subarray(pos, pos + size), defer); }
}
for (const size of [1e9, 188, 77, 1]) {
    it(`[tsmf-ts-integrity] 正常な52slot末尾を次ヘッダーなしで分離する (chunk=${size})`, t => {
        const { filter, written } = fixture(t), packets = frame();
        write(filter, [header(), ...packets], size);
        assert.deepEqual(Buffer.concat(written), Buffer.concat(packets.slice(0, 26)));
    });
}
for (const size of [1e9, 77, 1]) {
    it(`[tsmf-ts-integrity] 欠落したフレームから別相対TSを流さず次フレームで復帰する (chunk=${size})`, t => {
        const { filter, written } = fixture(t), broken = frame(), good = frame(60);
        write(filter, [header(), ...broken.slice(1)], size);
        assert.equal(Buffer.concat(written).length, 0, "1slot欠落後に他の相対TSを混入させません");
        write(filter, [header(1), ...good], size);
        assert.deepEqual(Buffer.concat(written), Buffer.concat(good.slice(0, 26)));
    });
    for (const kind of ["crc", "tei", "sync"]) {
        it(`[tsmf-ts-integrity] ${kind}不正のヘッダーは保留中の位置情報を破棄する (chunk=${size})`, t => {
            const { filter, written } = fixture(t), bad = header(1), packets = frame(), good = frame(60);
            if (kind === "crc") { bad[73] ^= 0x33; }
            if (kind === "tei") { bad[1] |= 0x80; }
            if (kind === "sync") { bad[4] ^= 1; }
            write(filter, [header(), ...packets.slice(0, 8), bad, ...packets], size);
            assert.equal(Buffer.concat(written).length, 0);
            write(filter, [header(2), ...good], size);
            assert.deepEqual(Buffer.concat(written), Buffer.concat(good.slice(0, 26)));
        });
    }
    it(`[tsmf-ts-integrity] sync-byte喪失を跨いで相対TSの位置を使い回さない (chunk=${size})`, t => {
        const { filter, written } = fixture(t), broken = frame(), good = frame(60);
        broken[8][0] = 0;
        write(filter, [header(), ...broken, header(1), ...good], size);
        assert.deepEqual(Buffer.concat(written), Buffer.concat(good.slice(0, 26)));
    });
}
for (const count of [0, 17, 51]) {
    it(`[tsmf-ts-integrity] 未完の${count}slot末尾をcloseで出力しない`, t => {
        const { filter, written } = fixture(t);
        write(filter, [header(), ...frame().slice(0, count)]);
        filter.close();
        assert.equal(Buffer.concat(written).length, 0);
    });
}
it("[tsmf-ts-integrity] データTEIとNULLも物理slotとして数え、正常な残りを保持する", t => {
    const { filter, written } = fixture(t), packets = frame();
    packets[3][1] |= 0x80;
    packets[10].set([0x47, 0x1F, 0xFF, 0x10]);
    write(filter, [header(), ...packets]);
    assert.deepEqual(Buffer.concat(written), Buffer.concat(packets.slice(0, 26).filter((_, i) => i !== 3 && i !== 10)));
});
it("[tsmf-ts-integrity] deferと遅延Writableの既出データを次フレームで書き換えない", async t => {
    const config = _.config; _.config = { server: {} };
    const chunks = [], pending = [];
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { chunks.push(chunk); pending.push(done); } });
    const filter = new TSFilter({ output, tsmfRelTs: 1 });
    t.after(() => { filter.close(false); output.destroy(); _.config = config; });
    const first = frame(), second = frame(60), third = frame(120);
    write(filter, [header(), ...first, header(1), ...second], 1e9, true);
    filter.flush();
    assert.ok(chunks.length > 0);
    const sent = Buffer.from(Buffer.concat(chunks));
    write(filter, [header(2), ...third], 77, true);
    assert.deepEqual(Buffer.concat(chunks), sent, "出力先へ渡したviewは後続入力で変わりません");
    while (pending.length) { pending.shift()(); await new Promise(resolve => setImmediate(resolve)); }
    filter.flush();
    while (pending.length) { pending.shift()(); await new Promise(resolve => setImmediate(resolve)); }
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, second, third].flatMap(packets => packets.slice(0, 26))));
});
for (const endOutput of [false, true]) {
    it(`[tsmf-ts-integrity] close(${endOutput})は確定済みdefer出力と未完末尾を区別する`, t => {
        const { filter, output, written } = fixture(t), first = frame(), partial = frame(60);
        // 最初のPATまではdeferでも即時出力する既存動作を通し、その後の保留を検証する。
        const initial = frame(150), pat = Buffer.alloc(188, 0xFF);
        pat.set([0x47, 0x40, 0, 0x10, 0, 0, 0xB0, 13, 0, 1, 0xC1, 0, 0, 0, 1, 0xE1, 0]);
        pat.writeUInt32BE(TsCrc32.calc(pat.subarray(5, 17)) >>> 0, 17);
        initial[0] = pat;
        write(filter, [header(15), ...initial], 77, true);
        assert.deepEqual(Buffer.concat(written), Buffer.concat(initial.slice(0, 26)));
        written.length = 0;
        write(filter, [header(), ...first, header(1), ...partial.slice(0, 17)], 77, true);
        assert.equal(written.length, 0);
        filter.close(endOutput);
        assert.deepEqual(Buffer.concat(written), endOutput ? Buffer.concat(first.slice(0, 26)) : Buffer.alloc(0));
        assert.equal(output.writableEnded, endOutput);
    });
}
