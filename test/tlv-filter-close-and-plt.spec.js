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
const { Writable } = require("node:stream");
const { calculateCRC32 } = require("arib-mmt-tlv-ts/crc-32.js");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0 }, errorCount: { bufferOverflow: 0 }
} } };
const logPath = require.resolve("../lib/Mirakurun/log");
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require("../lib/Mirakurun/_").default;
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;

function tlv(type, body) {
    const header = Buffer.from([0x7F, type, 0, 0]);
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
}
function mmtp(packetId, body, sequence = 0, indicator = 0) {
    const header = Buffer.alloc(12);
    header[0] = 0x40;
    header[1] = 2;
    header.writeUInt16BE(packetId, 2);
    header.writeUInt32BE(sequence, 8);
    return tlv(3, Buffer.concat([Buffer.from([0, sequence & 15, 0x61]), header, Buffer.from([indicator << 6, 0]), body]));
}
function section(tableId, payload) {
    const result = Buffer.alloc(3 + payload.length + 4);
    result[0] = tableId;
    result.writeUInt16BE(0xB000 | (payload.length + 4), 1);
    payload.copy(result, 3);
    result.writeUInt32BE(calculateCRC32(result.subarray(0, -4), -1) >>> 0, result.length - 4);
    assert.equal(calculateCRC32(result, -1), 0);
    return result;
}
function plt(serviceIds, version = 0) {
    const rows = serviceIds.map(serviceId => Buffer.from([2, 0, serviceId, 0, 0, serviceId === 101 ? 0x10 : 0x11]));
    const body = Buffer.concat([Buffer.from([serviceIds.length]), ...rows, Buffer.from([0])]);
    const table = Buffer.concat([Buffer.from([0x80, version, body.length >> 8, body.length & 0xFF]), body]);
    const extension = Buffer.concat([Buffer.from([1]), table.subarray(0, 4), table]);
    const header = Buffer.alloc(7);
    header.writeUInt32BE(extension.length, 3);
    return mmtp(0, Buffer.concat([header, extension]), version);
}
function pf(eventId, sequence) {
    const payload = Buffer.from([0, 101, 0xC1 | ((sequence & 31) << 1), 0, 0, 8, 0, 0, 11, 0, 0x8B,
        eventId >> 8, eventId & 0xFF, 0xEE, 0x48, 0x12, 0x30, 0, 0, 0x30, 0, 0x80, 0]);
    const table = section(0x8B, payload);
    return mmtp(0x8000, Buffer.concat([Buffer.from([0x80, 0, 0, table.length >> 8, table.length & 0xFF]), table]), sequence);
}
const nullPacket = Buffer.from([0x7F, 0xFF, 0, 0]);
function fixture(t, options = {}) {
    const config = _.config;
    const program = _.program;
    _.config = { server: { eventEndTimeout: 50 } };
    _.program = { get: () => ({ startAt: Date.now(), duration: 3600000 }) };
    const output = new Writable({ write(chunk, encoding, done) { done(); } });
    const filter = new TLVFilter({ output, ...options });
    t.after(() => { filter.close(false); output.destroy(); _.config = config; _.program = program; });
    return { filter, output };
}
function assertReleased(filter, reader) {
    if (!filter._reader) { return; }
    assert.equal(reader.buffer.byteLength, 0, "閉鎖filterから参照されるreaderの入力を解放します");
    assert.equal(reader.contexts.size, 0);
    assert.equal(reader.siStatistics.size, 0);
    assert.equal(reader.mmtpReader.siPacketQueue.size, 0);
    assert.equal(reader.mmtpReader.packages.size, 0);
    assert.equal(reader.mmtpReader.assets.has(0x9000), false);
    assert.equal(reader.bytes_, 0);
}
it("[tlv-close-plt] 一度発見したサービスのp/f監視は一時的なPLT欠落後も継続する", t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 10, 17) });
    const { filter, output } = fixture(t, { networkId: 11, serviceId: 101, eventId: 7 });
    filter.write(Buffer.concat([plt([101]), pf(7, 0), nullPacket]));
    assert.equal(filter._ready, true);
    const first = filter._provideEventLastDetectedAt;
    filter.write(plt([102], 1));
    assert.equal(filter._serviceIds.has(101), false, "最新PLTのサービス一覧は巻き戻しません");
    assert.equal(filter._selector.ready, false, "最新PLTでメディア選択を無効化する動作は維持します");
    t.mock.timers.tick(100);
    filter.write(pf(7, 1));
    assert.ok(filter._provideEventLastDetectedAt > first, "指定番組の受信確認は更新します");
    assert.equal(filter._provideServiceFound, true);
    filter.write(pf(8, 2));
    t.mock.timers.tick(51);
    assert.equal(filter.closed, true, "予定時刻の監視を待たずに別番組のp/fで終了します");
    assert.equal(output.writableEnded, true);
});
it("[tlv-close-plt] PLTで一度も確認していないサービスはp/fだけでは準備完了にしない", t => {
    const { filter } = fixture(t, { networkId: 11, serviceId: 101, eventId: 7 });
    filter.write(Buffer.concat([plt([102]), pf(7, 0), nullPacket]));
    assert.equal(filter._provideServiceFound, false);
    assert.equal(filter._ready, false);
    assert.equal(filter.closed, false);
});
for (const endOutput of [false, true]) {
    it(`[tlv-close-plt] close(${endOutput})は保持中のSI断片とreader入力を解放する`, t => {
        const { filter, output } = fixture(t);
        const reader = filter._reader;
        filter.write(Buffer.concat([plt([101]), mmtp(0x9000, Buffer.alloc(60000, 0x12), 0, 1), nullPacket]));
        assert.ok(reader.contexts.size > 0);
        assert.ok(reader.mmtpReader.packages.size > 0);
        assert.equal(reader.mmtpReader.siPacketQueue.get(0x9000)[0].byteLength, 60000);
        // reader自身が保留する未完了入力も、filterの寿命を越えて残さないことを確認します。
        reader.push(Buffer.from([0x7F, 3, 0xFF, 0xFF, 0]));
        assert.ok(reader.buffer.byteLength > 0);
        filter.close(endOutput);
        filter.close(endOutput);
        assert.equal(filter.closed, true);
        assert.equal(output.writableEnded, endOutput);
        assertReleased(filter, reader);
    });
}
it("[tlv-close-plt] readerのnetwork通知中に閉じても後続パケットで保持領域を作り直さない", t => {
    const { filter } = fixture(t, { parseNIT: true });
    const reader = filter._reader;
    let networks = 0;
    filter.on("network", () => { ++networks; filter.close(false); });
    const nit = tlv(0xFE, section(0x40, Buffer.from("1234C10000F000F000", "hex")));
    assert.doesNotThrow(() => filter.write(Buffer.concat([nit, plt([101]), nullPacket])));
    assert.equal(networks, 1);
    assert.equal(filter.closed, true);
    assert.equal(filter._readerBuffer, null);
    assertReleased(filter, reader);
});
it("[tlv-close-plt] readerのEIT通知中に閉じても同じreaderへ書き込みを続けない", t => {
    const { filter } = fixture(t, { networkId: 11, serviceId: 101, eventId: 7 });
    const reader = filter._reader;
    reader.addEventListener("eit", () => filter.close(false));
    assert.doesNotThrow(() => filter.write(Buffer.concat([plt([101]), pf(7, 0), nullPacket])));
    assert.equal(filter.closed, true);
    assertReleased(filter, reader);
});
