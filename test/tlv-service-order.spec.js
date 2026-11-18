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
require("reflect-metadata");
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0 }
} } };
const eventPath = require.resolve("../lib/Mirakurun/log");
require.cache[eventPath] = { id: eventPath, filename: eventPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require("../lib/Mirakurun/_").default;
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;

function mmtp(packetId, type, payload) {
    const header = Buffer.alloc(19);
    header.set([0x7F, 0x03]);
    header.writeUInt16BE(15 + payload.length, 2);
    header.set([0, 1, 0x61, 0x40, type], 4);
    header.writeUInt16BE(packetId, 9);
    return Buffer.concat([header, payload]);
}
function table(id, version, body) {
    const header = Buffer.from([id, version, 0, 0]);
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
}
function plt(packages, version = 0) {
    const rows = packages.map(([serviceId, packetId]) => {
        const row = Buffer.from([2, 0, serviceId, 0, 0, 0]);
        row.writeUInt16BE(packetId, 4);
        return row;
    });
    return table(0x80, version, Buffer.concat([Buffer.from([rows.length]), ...rows, Buffer.from([0])]));
}
function mpt(serviceId, asset, version = 0) {
    const body = Buffer.from([0xFF, 2, 0, serviceId, 0, 0, 1,
        0, 0, 0, 0, 0, 2, 0, 0, 0x68, 0x65, 0x76, 0x31, 0xFE, 1, 0, asset >> 8, asset & 0xFF, 0, 0]);
    return table(0x20, version, body);
}
function pa(packetId, content) {
    const extension = Buffer.concat([Buffer.from([1]), content.subarray(0, 4), content]);
    const message = Buffer.alloc(7);
    message.writeUInt32BE(extension.length, 3);
    return mmtp(packetId, 2, Buffer.concat([Buffer.from([0, 0]), message, extension]));
}
function packetIds(data) {
    const ids = [];
    for (let pos = 0; pos < data.length; pos += 4 + data.readUInt16BE(pos + 2)) {
        assert.equal(data[pos], 0x7F);
        ids.push(data.readUInt16BE(pos + 9));
    }
    return ids;
}
function run(t, packets, split, defer) {
    _.config = { server: {} };
    const written = [];
    const output = new Writable({ write(chunk, encoding, done) { written.push(Buffer.from(chunk)); done(); } });
    const filter = new TLVFilter({ output, serviceId: 1 });
    t.after(() => { filter.close(false); output.destroy(); });
    const start = Buffer.concat([pa(0, plt([[1, 0x10], [2, 0x11]])), pa(0x10, mpt(1, 0x100))]);
    filter.write(start, defer);
    assert.equal(filter._ready, true);
    filter.flush();
    written.length = 0;
    const input = Buffer.concat(packets);
    const chunks = split === "packets" ? packets : split === "bytes" ? [...input].map(byte => Buffer.from([byte])) : [input];
    for (const chunk of chunks) { filter.write(chunk, defer); }
    filter.flush();
    assert.equal(filter.closed, false);
    assert.equal(filter._rejectedPackets.size, 0);
    return { data: Buffer.concat(written), packets: filter.streamInfo[3].packet };
}
for (const defer of [false, true]) {
    for (const split of ["whole", "bytes"]) {
        it(`[tlv-service-order.spec] MPT更新前のメディアには更新前の資産選択を使う (split=${split}, defer=${defer})`, t => {
            const media = id => mmtp(id, 0, Buffer.alloc(20, 0x11));
            const packets = [media(0x100), media(0x100), pa(0x10, mpt(1, 0x101, 1)), media(0x101), media(0x100)];
            const expected = run(t, packets, "packets", defer);
            assert.deepEqual(packetIds(expected.data), [0x100, 0x100, 0x10, 0x101]);
            const actual = run(t, packets, split, defer);
            assert.deepEqual(actual, expected);
        });
        it(`[tlv-service-order.spec] PLT更新前のMPTには更新前のパッケージ選択を使う (split=${split}, defer=${defer})`, t => {
            const packets = [pa(0x10, mpt(1, 0x100, 1)), pa(0, plt([[1, 0x11], [2, 0x10]], 1)),
                pa(0x11, mpt(1, 0x101, 2)), pa(0x10, mpt(2, 0x200, 2))];
            const expected = run(t, packets, "packets", defer);
            assert.deepEqual(packetIds(expected.data), [0x10, 0, 0x11]);
            const actual = run(t, packets, split, defer);
            assert.deepEqual(actual, expected);
        });
    }
}

for (const defer of [false, true]) {
    it(`[tlv-service-order.spec] サービス選択後の保留は共有する大きな入力を保持せず上限内に収める (defer=${defer})`, t => {
        _.config = { server: { maxBufferBytesBeforeReady: 512 } };
        let blocked = false;
        const written = [];
        const output = new Writable({ highWaterMark: 1, write(chunk, encoding, done) {
            written.push(Buffer.from(chunk));
            if (!blocked) { done(); }
        } });
        const filter = new TLVFilter({ output, serviceId: 1 });
        t.after(() => { filter.close(false); output.destroy(); });
        filter.write(Buffer.concat([pa(0, plt([[1, 0x10]])), pa(0x10, mpt(1, 0x100))]));
        assert.equal(filter._ready, true);
        written.length = 0;
        blocked = true;
        output.write(Buffer.from([0]));
        const ignored = mmtp(0x999, 0, Buffer.alloc(1024));
        const kept = mmtp(0x100, 0, Buffer.alloc(20));
        const input = Buffer.concat([kept, ...Array(1024).fill(ignored), kept]);
        assert.ok(input.length > 1024 * 1024);
        for (let i = 0; i < 12; ++i) {
            filter.write(input, defer);
            filter.flush();
            assert.ok(filter._bufferBytes <= 512);
            assert.equal(filter._bufferRetainedCount, filter._buffer.length);
            assert.ok(filter._buffer.every(packet => packet.buffer !== input.buffer), "保留するパケットは入力から独立させます");
            const owners = new Set(filter._buffer.map(packet => packet.buffer));
            // 小さな所有bufferにはNodeのpool単位の余白があるため、論理保持量と大きな入力の参照を分けて検査します。
            assert.ok(filter._buffer.length <= Math.floor(512 / (2 * kept.length)));
            assert.ok([...owners].every(owner => owner.byteLength <= 2 * Buffer.poolSize));
            assert.ok(packetIds(Buffer.concat(filter._buffer)).every(id => id === 0x100));
        }
        assert.equal(filter.closed, false);
        assert.equal(filter._readerBuffer, null);
        assert.equal(filter._countBuffer, null);
        assert.ok(filter._bufferBytes > 0);
        assert.deepEqual(written, [Buffer.from([0])]);
    });
}
for (const failure of [false, true]) {
    it(`[tlv-service-order.spec] サービス表の通知で終了した後は末尾を処理せず保持領域を作り直さない (failure=${failure})`, t => {
        _.config = { server: {} };
        const written = [];
        const output = new Writable({ write(chunk, encoding, done) { written.push(Buffer.from(chunk)); done(); } });
        const filter = new TLVFilter({ output, serviceId: 1 });
        t.after(() => { filter.close(false); output.destroy(); });
        let callbacks = 0;
        filter._reader.addEventListener("mpt", () => {
            ++callbacks;
            if (failure) { throw new Error("service table listener failed"); }
            filter.close(false);
        });
        const error = t.mock.method(require(eventPath), "error", () => {});
        const input = Buffer.concat([pa(0, plt([[1, 0x10]])), pa(0x10, mpt(1, 0x100)),
            mmtp(0x100, 0, Buffer.alloc(20)), pa(0x10, mpt(1, 0x101, 1)), Buffer.from([0x7F, 0x03])]);
        assert.doesNotThrow(() => filter.write(input, true));
        assert.equal(filter.closed, true);
        assert.equal(callbacks, 1);
        assert.equal(error.mock.callCount(), Number(failure));
        if (failure) { assert.match(error.mock.calls[0].arguments.join(" "), /service table listener failed/); }
        assert.deepEqual(written, []);
        assert.equal(filter._buffer.length, 0);
        assert.equal(filter._readerBuffer, null);
        assert.equal(filter._readerStorage, null);
        assert.equal(filter._countBuffer, null);
        assert.equal(filter._countStorage, null);
        assert.equal(filter._rejectedPackets.size, 0);
    });
}

for (const defer of [false, true]) {
    for (const split of ["whole", "bytes"]) {
        it(`[tlv-service-order.spec] PLTでMPTのPIDが変わったら新しいMPTまで旧資産を使わない (split=${split}, defer=${defer})`, t => {
            const media = id => mmtp(id, 0, Buffer.alloc(20, 0x11));
            const packets = [media(0x100), pa(0, plt([[1, 0x12], [2, 0x11]], 1)), media(0x101),
                pa(0x12, mpt(1, 0x102, 1)), media(0x101), media(0x102), media(0x100)];
            const expected = run(t, packets, "packets", defer);
            assert.deepEqual(packetIds(expected.data), [0x100, 0, 0x101, 0x12, 0x102]);
            assert.deepEqual(run(t, packets, split, defer), expected);
        });
        it(`[tlv-service-order.spec] 同じPLTの再送は既存MPTの資産選択を維持する (split=${split}, defer=${defer})`, t => {
            const media = id => mmtp(id, 0, Buffer.alloc(20, 0x11));
            const packets = [pa(0, plt([[1, 0x10], [2, 0x11]], 1)), media(0x100), media(0x101)];
            const expected = run(t, packets, "packets", defer);
            assert.deepEqual(packetIds(expected.data), [0, 0x100]);
            assert.deepEqual(run(t, packets, split, defer), expected);
        });
        it(`[tlv-service-order.spec] PLTから消えたサービスが戻っても除外前の資産選択を再利用しない (split=${split}, defer=${defer})`, t => {
            const media = id => mmtp(id, 0, Buffer.alloc(20, 0x11));
            const packets = [pa(0, plt([[2, 0x11]], 1)), media(0x101),
                pa(0, plt([[1, 0x10], [2, 0x11]], 2)), media(0x102),
                pa(0x10, mpt(1, 0x103, 1)), media(0x103), media(0x102)];
            const expected = run(t, packets, "packets", defer);
            assert.deepEqual(packetIds(expected.data), [0, 0x101, 0, 0x102, 0x10, 0x103]);
            assert.deepEqual(run(t, packets, split, defer), expected);
        });
    }
}

for (const defer of [false, true]) {
    for (const separated of [false, true]) {
        it(`[tlv-service-order.spec] 連続する選択済みパケットはコピーせずまとめて出力する (defer=${defer}, separated=${separated})`, t => {
            _.config = { server: {} };
            const written = [];
            const output = new Writable({ write(chunk, encoding, done) { written.push(chunk); done(); } });
            const filter = new TLVFilter({ output, serviceId: 1 });
            t.after(() => { filter.close(false); output.destroy(); });
            filter.write(Buffer.concat([pa(0, plt([[1, 0x10]])), pa(0x10, mpt(1, 0x100))]));
            assert.equal(filter._ready, true);
            written.length = 0;
            const media = mmtp(0x100, 0, Buffer.alloc(256, 0x11));
            const ignored = mmtp(0x999, 0, Buffer.alloc(256, 0x22));
            const first = Buffer.concat(Array(16).fill(media));
            const input = separated ? Buffer.concat([first, ignored, first]) : first;
            filter.write(input, defer);
            filter.flush();
            assert.equal(written.length, separated ? 2 : 1);
            assert.deepEqual(Buffer.concat(written), separated ? Buffer.concat([first, first]) : first);
            for (const chunk of written) {
                assert.equal(chunk.buffer, input.buffer, "選択した入力の連続区間をコピーせず参照します");
            }
            assert.equal(filter.closed, false);
        });
    }
}

function startSelection(t, packets, split, defer, options = {}) {
    _.config = { server: {} };
    if (options.eventId !== undefined) {
        const previousProgram = _.program;
        _.program = { get: () => ({ startAt: options.startAt, duration: options.duration }) };
        t.after(() => { _.program = previousProgram; });
    }
    const written = [];
    const output = new Writable({ write(chunk, encoding, done) { written.push(Buffer.from(chunk)); done(); } });
    const filter = new TLVFilter({ output, networkId: 11, serviceId: 1, ...options });
    t.after(() => { filter.close(false); output.destroy(); });
    const input = Buffer.concat(packets);
    const chunks = split === "packets" ? packets : split === "bytes" ? [...input].map(byte => Buffer.from([byte])) : [input];
    for (const chunk of chunks) { filter.write(chunk, defer); }
    filter.flush();
    assert.equal(filter.closed, false);
    return { filter, written };
}
function startEvent(eventId) {
    const { calculateCRC32 } = require("arib-mmt-tlv-ts/crc-32.js");
    const payload = Buffer.from([0, 1, 0xC1, 0, 0, 8, 0, 0, 11, 0, 0x8B,
        eventId >> 8, eventId & 0xFF, 0xEE, 0x48, 0x12, 0x30, 0, 0, 0x30, 0, 0x80, 0]);
    const section = Buffer.alloc(3 + payload.length + 4);
    section[0] = 0x8B;
    section.writeUInt16BE(0xB000 | (payload.length + 4), 1);
    payload.copy(section, 3);
    section.writeUInt32BE(calculateCRC32(section.subarray(0, -4), -1) >>> 0, section.length - 4);
    return mmtp(0x8000, 2, Buffer.concat([Buffer.from([0, 0, 0x80, 0, 0, 0, section.length]), section]));
}
for (const defer of [false, true]) {
    for (const split of ["whole", "packets", "bytes"]) {
        it(`[tlv-service-order.spec] サービス指定だけの開始はMPTより前の他サービスを出力しない (split=${split}, defer=${defer})`, t => {
            const media = id => mmtp(id, 0, Buffer.alloc(20, 0x11));
            const packets = [media(0x200), media(0x100), pa(0, plt([[1, 0x10], [2, 0x11]])),
                media(0x200), pa(0x10, mpt(1, 0x100)), media(0x100), media(0x200)];
            const { filter, written } = startSelection(t, packets, split, defer);
            assert.equal(filter._ready, true);
            assert.deepEqual(packetIds(Buffer.concat(written)), [0x10, 0x100]);
            assert.deepEqual(Buffer.concat(written), Buffer.concat([packets[4], packets[5]]));
            assert.equal(filter._bufferBytes, 0);
        });
        it(`[tlv-service-order.spec] 番組指定の開始は対象MPT後の先行パケットを保持する (split=${split}, defer=${defer})`, t => {
            const media = id => mmtp(id, 0, Buffer.alloc(20, 0x11));
            const packets = [media(0x200), media(0x100), pa(0, plt([[1, 0x10], [2, 0x11]])),
                media(0x200), pa(0x10, mpt(1, 0x100)), media(0x100), media(0x200)];
            const { filter, written } = startSelection(t, packets, split, defer,
                { eventId: 7, startAt: Date.now() + 10000, duration: 1000 });
            assert.equal(filter._ready, false);
            assert.deepEqual(written, []);
            assert.ok(filter._bufferBytes > 0);
            assert.deepEqual(packetIds(Buffer.concat(filter._buffer)), [0x10, 0x100]);
            filter.write(startEvent(7), defer);
            filter.flush();
            assert.equal(filter._ready, true);
            assert.deepEqual(packetIds(Buffer.concat(written)), [0x10, 0x100, 0x8000]);
            assert.equal(filter._bufferBytes, 0);
        });
    }
}
