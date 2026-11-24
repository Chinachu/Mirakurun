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
const { it } = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
const { Writable } = require("node:stream");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0 } } } };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const eventPath = require.resolve("../lib/Mirakurun/log");
require.cache[eventPath] = { id: eventPath, filename: eventPath, loaded: true, exports: logger };
const _ = require("../lib/Mirakurun/_").default;

const TSMFBonding = require("../lib/Mirakurun/TSMFBonding").default;
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
const message = args => util.format(...args.slice(0));
it("[tsmf-bonding-diagnostics.spec] 受信停止と未整列の終了通知も日本語で理由を返す", t => {
    const errors = [];
    const stalled = new TSMFBonding(1, 2, reason => errors.push(reason));
    t.after(() => stalled.close());
    stalled._received = 1201;
    stalled._lastReceived = [1201, 0];
    stalled._assemble([]);
    assert.deepEqual(errors, ["一部の搬送波を一定期間受信できませんでした"]);
    assert.equal(stalled._closed, true);
    const unaligned = new TSMFBonding(1, 2, reason => errors.push(reason));
    t.after(() => unaligned.close());
    unaligned._interruptions = 3;
    unaligned._received = 7201;
    unaligned._lost(unaligned._inputs[0]);
    assert.equal(errors[1], "搬送波の位置を確定できませんでした");
    assert.equal(unaligned._closed, true);
});
for (const repeated of [false, true]) {
    it(`[tsmf-bonding-diagnostics.spec] 搬送波の構成不一致はTLVFilterに日本語の詳細を残して1回だけ閉じる (duplicate=${repeated})`, t => {
        _.config = { server: {} };
        const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        const filter = new TLVFilter({ output, tsmfRelTs: 1, tsmfCarriers: 2 });
        const errors = t.mock.method(logger, "error", () => {});
        const closed = t.mock.fn(); filter.on("close", closed);
        t.after(() => { filter.close(false); output.destroy(); });
        const bonding = filter._bonding;
        bonding._inputs.forEach((carrier, index) => {
            carrier.carrierSequence = repeated ? 1 : index;
            carrier.numberOfCarriers = repeated ? 2 : 3;
        });
        assert.doesNotThrow(() => bonding._assemble([]));
        assert.equal(filter.closed, true);
        assert.equal(output.writableEnded, true);
        assert.equal(closed.mock.callCount(), 1);
        assert.equal(errors.mock.callCount(), 1);
        const text = message(errors.mock.calls[0].arguments);
        assert.match(text, /搬送波を結合できないため配信を終了します/);
        assert.match(text, repeated ? /複数のチャンネルで同じ搬送波を受信しました.*carrier_sequence: 1, 1/ : /搬送波数がグループのチャンネル数と一致しません.*受信=3.*設定=2/);
        assert.doesNotMatch(text, /the number|same carrier/);
        assert.equal(bonding.push(0, Buffer.alloc(188)).length, 0);
    });
}

function bondingHeader(cc, sequence = 1, tlv = true) {
    const packet = Buffer.alloc(188, 0xFF);
    packet[0] = 0x47; packet[1] = 0; packet[2] = 0x2F; packet[3] = 0x10 | cc;
    const payload = packet.subarray(4);
    payload[0] = 0x1A; payload[1] = 0x86; payload[2] = 2;
    payload.fill(0x11, 69, 95);
    const streamTypes = tlv ? 0x3FFF : 0x7FFF;
    payload[121] = streamTypes >> 7; payload[122] = (streamTypes << 1) & 0xFF;
    payload[124] = 2; payload[125] = sequence; payload[126] = 0x10;
    let crc = 0xFFFFFFFF;
    for (const byte of payload.subarray(0, 180)) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; ++bit) { crc = crc & 0x80000000 ? (crc << 1) ^ 0x04C11DB7 : crc << 1; }
    }
    payload.writeUInt32BE(crc >>> 0, 180);
    return packet;
}

for (const warning of ["non-tlv", "carrier-order"]) {
    for (const withFilter of [false, true]) {
        it(`[tsmf-bonding-diagnostics.spec] 同じchunkの停止後に${warning}の警告を追加しない (filter=${withFilter})`, t => {
            _.config = { server: {} };
            const timeline = [];
            const warnings = t.mock.method(logger, "warn", (...args) => timeline.push({ level: "warn", text: message(args) }));
            const errors = t.mock.method(logger, "error", (...args) => timeline.push({ level: "error", text: message(args) }));
            let stopped = 0;
            let filter;
            let output;
            if (withFilter) {
                output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
                filter = new TLVFilter({ output, tsmfRelTs: 1, tsmfCarriers: 2 });
            }
            const bonding = filter ? filter._bonding : new TSMFBonding(1, 2, reason => {
                ++stopped; timeline.push({ level: "stop", text: reason });
            });
            const closed = t.mock.fn(); filter?.on("close", closed);
            t.after(() => { filter?.close(false); bonding.close(); output?.destroy(); });
            bonding._interruptions = 3;
            bonding._received = 7201;
            bonding._inputs[0].carrierSequence = 1;
            const first = bondingHeader(0);
            const later = bondingHeader(1, warning === "carrier-order" ? 2 : 1, warning !== "non-tlv");
            assert.notEqual(require("../lib/Mirakurun/TSMFTLV").parseTSMFHeader(first), null, "最初のヘッダーは有効なCRCです");
            assert.notEqual(require("../lib/Mirakurun/TSMFTLV").parseTSMFHeader(later), null, "停止後のヘッダーもCRC検証を通ります");
            assert.equal(bonding.push(0, Buffer.concat([first, later])).length, 0);
            assert.equal(bonding._closed, true);
            assert.equal(warnings.mock.callCount(), 0, "終了の通知より後に入力の警告を残しません");
            assert.equal(bonding._warned.size, 0, "停止後の警告を重複抑制用の集合にも保持しません");
            if (withFilter) {
                assert.equal(filter.closed, true); assert.equal(output.writableEnded, true);
                assert.equal(closed.mock.callCount(), 1); assert.equal(errors.mock.callCount(), 1);
                assert.match(timeline[0].text, /搬送波を結合できないため配信を終了します.*搬送波の位置を確定できませんでした/);
            } else {
                assert.equal(stopped, 1); assert.equal(errors.mock.callCount(), 0);
                assert.deepEqual(timeline, [{ level: "stop", text: "搬送波の位置を確定できませんでした" }]);
            }
            assert.equal(bonding.push(0, later).length, 0);
            assert.equal(warnings.mock.callCount(), 0);
        });
    }
    it(`[tsmf-bonding-diagnostics.spec] 稼働中の${warning}の警告は1回だけ残す`, t => {
        const warnings = t.mock.method(logger, "warn", () => {});
        const errors = [];
        const bonding = new TSMFBonding(1, 2, reason => errors.push(reason));
        t.after(() => bonding.close());
        const headers = warning === "non-tlv"
            ? [bondingHeader(0), bondingHeader(1, 1, false), bondingHeader(2, 1, false)]
            : [bondingHeader(0), bondingHeader(1), bondingHeader(2, 2), bondingHeader(3, 2)];
        assert.equal(bonding.push(0, Buffer.concat(headers)).length, 0);
        assert.equal(bonding._closed, false); assert.deepEqual(errors, []);
        assert.equal(warnings.mock.callCount(), 1);
        assert.match(message(warnings.mock.calls[0].arguments), warning === "non-tlv" ? /the relative stream .* is not TLV/ : /the carrier sequence has changed/);
        assert.equal(bonding._warned.size, 1);
    });
}
