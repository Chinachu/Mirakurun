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
const { Writable } = require("node:stream");
const { TsCrc32 } = require("@chinachu/aribts");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0 }
} } };
const _ = require("../lib/Mirakurun/_").default;
const TSFilter = require("../lib/Mirakurun/TSFilter").default;
const TSMFTLV = require("../lib/Mirakurun/TSMFTLV").default;
const event = require("../lib/Mirakurun/log");
function fixture(t, options = {}) {
    _.config = { server: {} };
    for (const level of ["info", "warn", "error", "debug"]) { t.mock.method(event, level, () => {}); }
    const written = [];
    const output = new Writable({ write(chunk, _encoding, done) { written.push(Buffer.from(chunk)); done(); } });
    const filter = new TSFilter({ output, rawTsmf: true, ...options });
    t.after(() => { filter.close(false); output.destroy(); });
    return { filter, written, output };
}
function packet(pid, tei = false) {
    const value = Buffer.alloc(188, 0xA5);
    value[0] = 0x47; value[1] = (pid >> 8) | (tei ? 0x80 : 0); value[2] = pid & 0xFF; value[3] = 0x10;
    return value;
}
function forward(filter, input, size, defer = false) {
    for (let offset = 0; offset < input.length; offset += size) { filter.write(input.subarray(offset, offset + size), defer); }
}
for (const size of [188 * 8, 188, 77]) {
    it(`[raw-tsmf-filter.spec] rawはNULLとTEIを含む外側TSの全パケットを保持する (chunk=${size})`, t => {
        const { filter, written } = fixture(t);
        const input = Buffer.concat([packet(0x2F), packet(0x1FFF), packet(0x2D), packet(0x100, true), packet(0, true), packet(0x1FFF)]);
        forward(filter, input, size); filter.flush();
        assert.deepEqual(Buffer.concat(written), input);
        assert.equal(filter.streamInfo[0x1FFF].packet, 2);
        assert.equal(filter.streamInfo[0x100].packet, 1);
        assert.equal(filter.streamInfo[0x100].drop, 0);
    });
}
it("[raw-tsmf-filter.spec] rawは相対TS・番組条件・EPG解析を適用しない", async t => {
    const { filter, written } = fixture(t, { tsmfRelTs: 3, networkId: 4, serviceId: 101, eventId: 888,
        parseNIT: true, parseSDT: true, parseEIT: true, parseNetworkStreams: true, startAt: Date.now(), duration: 1 });
    const parse = t.mock.method(filter._parser, "write", () => {});
    const input = Buffer.concat([packet(0, true), packet(0x10), packet(0x11), packet(0x12), packet(0x14), packet(0x1FFF)]);
    filter.write(input); filter.flush();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Buffer.concat(written), input);
    assert.equal(filter._ready, true);
    assert.equal(parse.mock.callCount(), 0);
    assert.equal(filter._provideEventTimeout, null);
});
it("[raw-tsmf-filter.spec] rawのdeferとcloseは既存出力バッファの境界を維持する", t => {
    const { filter, written, output } = fixture(t);
    const input = Buffer.concat([packet(0x2F), packet(0x1FFF), packet(0x2D)]);
    filter.write(input, true);
    assert.equal(written.length, 0);
    filter.close();
    assert.deepEqual(Buffer.concat(written), input);
    assert.equal(output.writableEnded, true);
    assert.throws(() => filter.write(input), /closed/);
});
function header(cc) {
    const value = packet(0x2F);
    value[3] = 0x10 | cc;
    const payload = value.subarray(4);
    payload.fill(0xFF); payload[0] = 0x1A; payload[1] = 0x86; payload[2] = 2;
    for (let i = 0; i < 26; ++i) { payload[69 + i] = 0x11; }
    const streamTypes = 0x3FFF; // 相対TS1だけTLV
    payload[121] = streamTypes >> 7; payload[122] = (streamTypes << 1) & 0xFF;
    payload[124] = 1; payload[125] = 1; payload[126] = 0x10;
    payload.writeUInt32BE(TsCrc32.calc(payload.subarray(0, 180)) >>> 0, 180);
    return value;
}
for (const size of [188 * 107, 188, 61]) {
    it(`[raw-tsmf-filter.spec] NULL入り52スロットをpeer転送してもローカルのTLV再展開を壊さない (chunk=${size})`, t => {
        const { filter, written } = fixture(t);
        const tlv = Buffer.alloc(184, 0x55); tlv[0] = 0x7F; tlv[1] = 0x01; tlv.writeUInt16BE(180, 2);
        const payload = packet(0x2D); payload[1] = 0x40; payload[3] = 0; tlv.copy(payload, 4);
        const nulls = count => Array.from({ length: count }, () => packet(0x1FFF));
        const input = Buffer.concat([header(0), ...nulls(52), header(1), payload, ...nulls(51), header(2)]);
        forward(filter, input, size); filter.flush();
        const forwarded = Buffer.concat(written);
        assert.deepEqual(forwarded, input);
        assert.deepEqual(new TSMFTLV(1).push(forwarded), tlv);
    });
}
