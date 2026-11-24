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
const { calculateCRC32 } = require("arib-mmt-tlv-ts/crc-32.js");
const statusPath = require.resolve("../lib/Mirakurun/status");
const status = { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0 }, errorCount: { bufferOverflow: 0 } };
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: status } };
const logPath = require.resolve("../lib/Mirakurun/log");
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require("../lib/Mirakurun/_").default;
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
const TSFilter = require("../lib/Mirakurun/TSFilter").default;

function mmtp(packetId, type, payload, sequence = 0) {
    const header = Buffer.alloc(19);
    header.set([0x7F, 3]);
    header.writeUInt16BE(15 + payload.length, 2);
    header.set([0, sequence & 15, 0x61, 0x40, type], 4);
    header.writeUInt16BE(packetId, 9);
    header.writeUInt32BE(sequence, 15);
    return Buffer.concat([header, payload]);
}
function table(id, body) {
    const header = Buffer.from([id, 0, 0, 0]);
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
}
function pa(packetId, content) {
    const extension = Buffer.concat([Buffer.from([1]), content.subarray(0, 4), content]);
    const header = Buffer.alloc(7);
    header.writeUInt32BE(extension.length, 3);
    return mmtp(packetId, 2, Buffer.concat([Buffer.from([0, 0]), header, extension]));
}
function plt() {
    return pa(0, table(0x80, Buffer.from([2, 2, 0, 101, 0, 0, 0x10, 2, 0, 102, 0, 0, 0x11, 0])));
}
function mpt() {
    return pa(0x10, table(0x20, Buffer.from([0xFF, 2, 0, 101, 0, 0, 1,
        0, 0, 0, 0, 0, 2, 0, 0, 0x68, 0x65, 0x76, 0x31, 0xFE, 1, 0, 1, 0, 0, 0])));
}
function pf(eventId = 7, sequence = 0) {
    const payload = Buffer.from([0, 101, 0xC1, 0, 0, 8, 0, 0, 11, 0, 0x8B,
        eventId >> 8, eventId & 0xFF, 0xEE, 0x48, 0x12, 0x30, 0, 0, 0x30, 0, 0x80, 0]);
    const section = Buffer.alloc(3 + payload.length + 4);
    section[0] = 0x8B;
    section.writeUInt16BE(0xB000 | (payload.length + 4), 1);
    payload.copy(section, 3);
    section.writeUInt32BE(calculateCRC32(section.subarray(0, -4), -1) >>> 0, section.length - 4);
    assert.equal(calculateCRC32(section, -1), 0);
    return mmtp(0x8000, 2, Buffer.concat([Buffer.from([0, 0, 0x80, 0, 0, 0, section.length]), section]), sequence);
}
function media(marker, packetId = 0x100) {
    return mmtp(packetId, 0, Buffer.alloc(20, marker));
}
const nullPacket = Buffer.from([0x7F, 0xFF, 0, 0]);
function mediaMarkers(chunks) {
    const data = Buffer.concat(chunks);
    const markers = [];
    for (let pos = 0; pos < data.length;) {
        assert.equal(data[pos], 0x7F, "保持後もTLVのパケット境界を維持します");
        const end = pos + 4 + data.readUInt16BE(pos + 2);
        assert.ok(end <= data.length);
        if (data[pos + 1] === 3 && (data[pos + 8] & 0x3F) === 0) {
            assert.equal(data.readUInt16BE(pos + 9), 0x100, "他サービスのMPUを出力しません");
            markers.push(data[end - 1]);
        }
        pos = end;
    }
    return markers;
}
function fixture(t, options = {}, server = {}, outputOptions = {}) {
    const previousConfig = _.config;
    const previousProgram = _.program;
    _.config = { server };
    _.program = { get: () => ({ startAt: Date.now() + 1000, duration: 1000 }) };
    const written = [];
    const output = new Writable({ ...outputOptions, write(chunk, encoding, done) { written.push(Buffer.from(chunk)); done(); } });
    const filter = new TLVFilter({ output, networkId: 11, serviceId: 101, eventId: 7, ...options });
    t.after(() => { filter.close(false); output.destroy(); _.config = previousConfig; _.program = previousProgram; });
    return { filter, output, written };
}
for (const defer of [false, true]) {
    for (const split of [false, true]) {
        it(`[filter-preready] 番組指定では対象MPT後の先頭を準備完了まで保留する (defer=${defer}, split=${split})`, t => {
            const { filter, output, written } = fixture(t);
            const write = packet => {
                if (split) { for (const byte of packet) { filter.write(Buffer.from([byte]), defer); } }
                else { filter.write(packet, defer); }
            };
            write(Buffer.concat([plt(), mpt(), nullPacket]));
            write(pf(6));
            write(Buffer.concat([media(1), media(2)]));
            filter.flush();
            output.emit("drain");
            assert.equal(filter._ready, false);
            assert.deepEqual(written, [], "準備前はflushとdrainでも出力しません");
            assert.deepEqual(mediaMarkers(filter._buffer), [1, 2], "present通知が遅れても先頭のメディアを保持します");
            write(pf(7, 1));
            write(media(3));
            filter.flush();
            assert.equal(filter._ready, true, "実MH-EITで番組切り替えを検出します");
            assert.deepEqual(mediaMarkers(written), [1, 2, 3]);
            assert.equal(filter._bufferBytes, 0);
        });
    }
    it(`[filter-preready] 番組の準備待ちも上限を守り古い完全パケットから破棄する (defer=${defer})`, t => {
        const { filter, output, written } = fixture(t, {}, { maxBufferBytesBeforeReady: 256 });
        filter.write(Buffer.concat([plt(), mpt(), nullPacket]), defer);
        const overflowBefore = status.errorCount.bufferOverflow;
        for (let marker = 1; marker <= 20; ++marker) {
            filter.write(media(marker), defer);
            filter.flush();
            output.emit("drain");
            assert.ok(filter._bufferBytes <= 256);
        }
        const retained = mediaMarkers(filter._buffer);
        assert.ok(retained.length > 0 && retained.length < 20);
        assert.equal(retained.at(-1), 20);
        assert.equal(status.errorCount.bufferOverflow, overflowBefore, "番組開始前の通常の保持上限では異常に数えません");
        assert.deepEqual(written, []);
        filter.write(pf(), defer);
        filter.flush();
        assert.equal(filter._ready, true);
        assert.deepEqual(mediaMarkers(written), retained);
    });
    it(`[filter-preready] 準備後の出力詰まりによる破棄はoverflowへ数える (defer=${defer})`, async t => {
        const { filter, output, written } = fixture(t, {}, { maxBufferBytesBeforeReady: 256 }, { highWaterMark: 1 });
        filter.write(Buffer.concat([plt(), mpt(), pf(), nullPacket]), defer);
        filter.flush();
        assert.equal(filter._ready, true);
        written.length = 0;
        const pending = [];
        const blockedWrite = t.mock.method(output, "_write", (chunk, encoding, done) => {
            written.push(Buffer.from(chunk));
            pending.push(done);
        });
        filter.write(media(21), defer);
        filter.flush();
        assert.equal(pending.length, 1);
        assert.ok(output.writableLength >= output.writableHighWaterMark);
        const overflowBefore = status.errorCount.bufferOverflow;
        for (let marker = 22; marker <= 50; ++marker) {
            filter.write(media(marker), defer);
            filter.flush();
            assert.ok(filter._bufferBytes <= 256);
        }
        const retained = mediaMarkers(filter._buffer);
        assert.ok(retained.length > 0 && retained.length < 29);
        assert.equal(retained.at(-1), 50);
        assert.ok(status.errorCount.bufferOverflow > overflowBefore, "準備後の出力詰まりは異常として数えます");
        blockedWrite.mock.restore();
        pending.shift()();
        await new Promise(resolve => setImmediate(resolve));
        filter.flush();
        assert.equal(filter._bufferBytes, 0);
        assert.deepEqual(mediaMarkers(written), [21, ...retained]);
    });
}
for (const [name, options, expected] of [
    ["チャンネル視聴", { serviceId: undefined, eventId: undefined }, false],
    ["サービス視聴", { eventId: undefined }, false],
    ["番組指定", {}, true],
    ["EPG取得付き視聴", { eventId: undefined, parseEIT: true }, true],
    ["解析専用EPG取得", { output: undefined, eventId: undefined, parseEIT: true }, true]
]) {
    it(`[filter-preready] MH-EITの解析は利用するフィルターだけで行う (${name})`, t => {
        const { filter, written } = fixture(t, options);
        const received = [];
        t.mock.method(filter, "_onEIT", table => received.push(table));
        const eit = pf();
        filter.write(Buffer.concat([plt(), mpt(), eit, nullPacket]));
        filter.flush();
        assert.equal(received.length, expected ? 1 : 0);
        if (expected) {
            assert.equal(received[0].serviceId, 101);
            assert.equal(received[0].events[0].eventId, 7);
        } else {
            assert.ok(Buffer.concat(written).includes(eit), "解析しないMH-EITも出力には残します");
        }
        assert.equal(filter.closed, false);
    });
}
for (const combined of [false, true]) {
    it(`[filter-preready] 対象MPT前の未知MPUを後から遡って保持しない (combined=${combined})`, t => {
        const { filter, written } = fixture(t);
        const packets = [plt(), media(99, 0x200), mpt(), media(1), nullPacket];
        if (combined) { filter.write(Buffer.concat(packets)); }
        else { for (const packet of packets) { filter.write(packet); } }
        filter.write(pf());
        filter.flush();
        assert.equal(filter._ready, true);
        assert.deepEqual(mediaMarkers(written), [1]);
    });
}
for (const endOutput of [false, true]) {
    it(`[filter-preready] 準備前のclose(${endOutput})は保留を出力せず解放する`, t => {
        const { filter, output, written } = fixture(t);
        filter.write(Buffer.concat([plt(), mpt(), media(1), nullPacket]));
        filter.flush();
        assert.ok(filter._bufferBytes > 0);
        filter.close(endOutput);
        assert.deepEqual(written, []);
        assert.equal(filter.closed, true);
        assert.equal(output.writableEnded, endOutput);
        assert.equal(filter._buffer.length, 0);
    });
}
it("[filter-preready] サービス指定のみの場合はMPT前のメディアを新しく保持しない", t => {
    const { filter, written } = fixture(t, { eventId: undefined });
    filter.write(Buffer.concat([plt(), media(99, 0x200), nullPacket]));
    filter.flush();
    assert.deepEqual(written, []);
    assert.equal(filter._bufferBytes, 0);
    filter.write(Buffer.concat([mpt(), media(1)]));
    filter.flush();
    assert.equal(filter._ready, true);
    assert.deepEqual(mediaMarkers(written), [1]);
});
for (const [name, Filter] of [["TLVFilter", TLVFilter], ["TSFilter", TSFilter]]) {
    for (const withOutput of [false, true]) {
        it(`[filter-preready] ${name}の番組終了監視は出力ありの場合だけ動作する (output=${withOutput})`, t => {
            const previousConfig = _.config;
            const previousProgram = _.program;
            _.config = { server: {} };
            const now = Date.now();
            _.program = { get: () => ({ startAt: now, duration: 100 }) };
            t.mock.timers.enable({ apis: ["setTimeout"] });
            const output = new Writable({ write(chunk, encoding, done) { done(); } });
            const filter = new Filter({ ...(withOutput && { output }), networkId: 11, serviceId: 101, eventId: 7, startAt: now, duration: 100 });
            t.after(() => { filter.close(false); output.destroy(); _.config = previousConfig; _.program = previousProgram; });
            assert.equal(filter._provideEventTimeout !== null, withOutput);
            t.mock.timers.tick(200);
            assert.equal(filter.closed, withOutput, "解析専用フィルタを存在しない出力番組の終了時刻で閉じません");
            if (withOutput) { assert.equal(output.writableEnded, true); }
        });
    }
}
