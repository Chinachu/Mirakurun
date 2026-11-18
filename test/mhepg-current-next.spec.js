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
const { Writable } = require("node:stream");
const { calculateCRC32 } = require("arib-mmt-tlv-ts/crc-32.js");
const { readMessages } = require("arib-mmt-tlv-ts/mmt-si.js");
const statusPath = require.resolve("../lib/Mirakurun/status");
const status = { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0 }, errorCount: { bufferOverflow: 0 } };
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: status } };
const logPath = require.resolve("../lib/Mirakurun/log");
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require("../lib/Mirakurun/_").default;
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
const MHEPG = require("../lib/Mirakurun/MHEPG").default;

function mmtp(packetId, payload, sequence = 0) {
    const result = Buffer.alloc(21 + payload.length);
    result.set([0x7F, 3]); result.writeUInt16BE(result.length - 4, 2);
    result.set([0, sequence & 15, 0x61, 0x40, 2], 4);
    result.writeUInt16BE(packetId, 9); result.writeUInt32BE(sequence, 15);
    payload.copy(result, 21);
    return result;
}
function plt() {
    const table = Buffer.from([0x80, 0, 0, 8, 1, 2, 0, 101, 0, 0, 0x10, 0]);
    const payload = Buffer.concat([Buffer.from([1]), table.subarray(0, 4), table]);
    const header = Buffer.alloc(7); header.writeUInt32BE(payload.length, 3);
    return mmtp(0, Buffer.concat([header, payload]));
}
function eit(tableId, current, sequence, eventId = 1) {
    const payload = Buffer.from([0, 101, current ? 0xC1 : 0xC0, 0, 0, 8, 0, 0, 11, 0, tableId,
        0, eventId, 0xEE, 0x48, 0x12, 0x30, 0, 0, 0x30, 0, 0x80, 0]);
    const section = Buffer.alloc(3 + payload.length + 4);
    section[0] = tableId; section.writeUInt16BE(0xB000 | (payload.length + 4), 1); payload.copy(section, 3);
    section.writeUInt32BE(calculateCRC32(section.subarray(0, -4), -1) >>> 0, section.length - 4);
    assert.equal(calculateCRC32(section, -1), 0, "current/nextともCRCが一致したMH-EITを使います");
    const header = Buffer.from([0x80, 0, 0, 0, section.length]);
    return mmtp(0x8000, Buffer.concat([header, section]), sequence);
}
function programStore(t) {
    const original = { config: _.config, service: _.service, program: _.program };
    const programs = new Map();
    const additions = t.mock.fn(item => programs.set(item.id, { ...item }));
    const updates = t.mock.fn((id, fields) => Object.assign(programs.get(id), fields));
    _.config = { server: {} };
    _.service = { items: [{ networkId: 11, serviceId: 101 }], get: (nid, sid) => nid === 11 && sid === 101 ? { networkId: nid, serviceId: sid } : null };
    _.program = { get: id => programs.get(id), exists: id => programs.has(id), add: additions, set: updates };
    const cleanups = [];
    t.after(() => {
        try { for (const cleanup of cleanups) { cleanup(); } }
        finally { Object.assign(_, original); }
    });
    return { programs, additions, updates, cleanup: callback => cleanups.push(callback) };
}
function fixture(t, fragmented = false) {
    const store = programStore(t);
    const output = new Writable({ write(chunk, encoding, done) { done(); } });
    const filter = new TLVFilter({ output, parseEIT: true, networkId: 11, serviceId: 101, eventId: 1 });
    store.cleanup(() => { filter.close(false); output.destroy(); });
    const write = packet => {
        if (fragmented) { for (const byte of packet) { filter.write(Buffer.from([byte])); } }
        else { filter.write(packet); }
    };
    // 生TLVの最初の境界は、次のnullパケットの同期バイトで確認します。
    write(Buffer.concat([plt(), Buffer.from([0x7F, 0xFF, 0, 0])]));
    assert.equal(filter._provideServiceFound, true);
    return { ...store, filter, output, write };
}
for (const tableId of [0x8B, 0x8C, 0x94]) {
    for (const fragmented of [false, true]) {
        it(`[mhepg-current-next] 未適用MH-EITは番組・境界・取得状態を更新しない (table=${tableId.toString(16)}, fragmented=${fragmented})`, t => {
            const f = fixture(t, fragmented);
            const update = t.mock.method(f.filter._epgState, "update");
            f.write(eit(tableId, false, 0));
            assert.equal(f.filter.closed, false);
            assert.equal(f.filter._ready, false);
            assert.equal(f.filter._provideEventLastDetectedAt, -1);
            assert.equal(f.filter._provideEventId, 1);
            assert.equal(f.filter._epgReady, false);
            assert.equal(f.filter._epg, undefined);
            assert.equal(update.mock.callCount(), 0);
            assert.equal(f.additions.mock.callCount(), 0);
            assert.equal(f.updates.mock.callCount(), 0);
            assert.equal(Object.values(status.epgByStream).some(Boolean), false);
            f.write(eit(tableId, true, 1));
            assert.equal(f.filter.closed, false);
            assert.equal(f.programs.size, 1, "同じ版のcurrent表は実MHEPGを経由して番組を登録します");
            assert.equal([...f.programs.values()][0].eventId, 1);
            assert.equal(f.filter._ready, tableId === 0x8B);
            assert.equal(update.mock.callCount(), tableId === 0x8B ? 0 : 1);
            assert.equal(Object.values(status.epgByStream).some(Boolean), true);
        });
    }
}
for (const tableId of [0x8B, 0x8C, 0x94]) {
    it(`[mhepg-current-next] 独立したMHEPGも未適用表で番組や版管理を更新しない (table=${tableId.toString(16)})`, t => {
        const f = programStore(t);
        const epg = new MHEPG();
        f.cleanup(() => epg.end());
        const write = current => {
            const message = readMessages(eit(tableId, current, 0).subarray(21));
            assert.equal(message.messageId, "M2section");
            assert.equal(message.table.currentNextIndicator, current);
            epg.write(message.table);
        };
        write(false);
        assert.equal(f.additions.mock.callCount(), 0);
        assert.equal(f.updates.mock.callCount(), 0);
        assert.deepEqual(epg._epg, {});
        write(true);
        assert.equal(f.programs.size, 1);
        assert.equal([...f.programs.values()][0].eventId, 1);
    });
}
for (const fragmented of [false, true]) {
    it(`[mhepg-current-next] 開始後の未適用p/fは番組を終了させず、適用中p/fだけが終了させる (fragmented=${fragmented})`, t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const f = fixture(t, fragmented);
        f.write(eit(0x8B, true, 0));
        assert.equal(f.filter._ready, true);
        const lastDetected = f.filter._provideEventLastDetectedAt;
        const count = f.programs.size;
        f.write(eit(0x8B, false, 1, 2));
        assert.equal(f.filter._provideEventId, 1, "未適用の別番組で終了待ちへ移りません");
        assert.equal(f.filter._provideEventLastDetectedAt, lastDetected);
        assert.equal(f.programs.size, count);
        t.mock.timers.tick(2000);
        assert.equal(f.filter.closed, false);
        assert.equal(f.filter._ready, true);
        f.write(eit(0x8B, true, 2, 2));
        assert.equal(f.filter._provideEventId, null);
        t.mock.timers.tick(1000);
        assert.equal(f.filter.closed, true);
        assert.equal(f.output.writableEnded, true);
    });
}
