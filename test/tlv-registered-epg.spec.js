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
const { calculateCRC32 } = require("arib-mmt-tlv-ts/crc-32.js");
const feature = fs.existsSync(path.join(__dirname, "../src/Mirakurun"));
const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
const status = { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0 }, errorCount: { bufferOverflow: 0 } };
for (const [name, value] of [["status", { __esModule: true, default: status }], [feature ? "log" : "event-log", { info() {}, warn() {}, error() {}, debug() {} }]]) {
    const file = require.resolve(prefix + "/" + name);
    require.cache[file] = { id: file, filename: file, loaded: true, exports: value };
}
const _ = require(prefix + "/_").default;
const TLVFilter = require(prefix + "/TLVFilter").default;
const ProgramStore = feature ? undefined : require(prefix + "/models/Program").Program;
function packet(packetId, payload, sequence = 0) {
    const result = Buffer.alloc(21 + payload.length);
    result.set([0x7F, 3]); result.writeUInt16BE(result.length - 4, 2);
    result.set([0, sequence & 15, 0x61, 0x40, 2], 4);
    result.writeUInt16BE(packetId, 9); result.writeUInt32BE(sequence, 15);
    payload.copy(result, 21); return result;
}
function plt() {
    const table = Buffer.from([0x80, 0, 0, 8, 1, 2, 0, 101, 0, 0, 0x10, 0]);
    const payload = Buffer.concat([Buffer.from([1]), table.subarray(0, 4), table]);
    const header = Buffer.alloc(7); header.writeUInt32BE(payload.length, 3);
    return packet(0, Buffer.concat([header, payload]));
}
function eit(tableId) {
    const payload = Buffer.from([0, 101, 0xC1, 0, 0, 8, 0, 0, 11, 0, tableId,
        0, 1, 0xEE, 0x48, 0x12, 0x30, 0, 0, 0x30, 0, 0x80, 0]);
    const section = Buffer.alloc(3 + payload.length + 4);
    section[0] = tableId; section.writeUInt16BE(0xB000 | payload.length + 4, 1); payload.copy(section, 3);
    section.writeUInt32BE(calculateCRC32(section.subarray(0, -4), -1) >>> 0, section.length - 4);
    assert.equal(calculateCRC32(section, -1), 0);
    return packet(0x8000, Buffer.concat([Buffer.from([0x80, 0, 0, 0, section.length]), section]));
}
for (const registered of ["none", "other-network", "registered"]) {
    for (const tableId of [0x8B, 0x8C, 0x94]) {
        for (const split of [false, true]) {
            it(`[tlv-registered-epg] 登録済みのNID/SIDだけを保存し、未登録のp/fによる番組監視は維持する (${registered}, table=${tableId.toString(16)}, split=${split})`, t => {
                const previous = { config: _.config, service: _.service, program: _.program };
                const programs = new Map();
                const items = registered === "none" ? [] : [{ networkId: registered === "registered" ? 11 : 12, serviceId: 101,
                    streamId: 0x800, isTlv: true, channel: { type: "BS4K" } }];
                _.config = { server: {} };
                _.service = { items, get: (nid, sid) => items.find(item => item.networkId === nid && item.serviceId === sid) || null };
                if (feature) {
                    _.program = { exists: id => programs.has(id), get: id => programs.get(id),
                        add: item => programs.set(item.id, { ...item }), set: (id, item) => Object.assign(programs.get(id), item) };
                } else {
                    t.mock.method(ProgramStore, "upsertFromEpg", (item, options = {}) => {
                        const stored = programs.get(item.id);
                        if (options.insertOnly && stored) { return; }
                        programs.set(item.id, { ...stored, ...item });
                    });
                    t.mock.method(ProgramStore, "reconcileEpgListing", () => true);
                }
                const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
                let filter;
                t.after(() => { filter?.close(false); output.destroy(); Object.assign(_, previous); });
                filter = new TLVFilter({ output, networkId: 11, serviceId: 101, eventId: 1, parseEIT: true });
                const update = t.mock.method(filter._epgState, "update");
                const write = buffer => {
                    if (split) { for (const byte of buffer) { filter.write(Buffer.from([byte])); } }
                    else { filter.write(buffer); }
                };
                write(Buffer.concat([plt(), Buffer.from([0x7F, 0xFF, 0, 0])]));
                assert.equal(filter._provideServiceFound, true, "PLTからのサービス発見は登録前でも維持します");
                write(eit(tableId));
                assert.equal(filter.closed, false);
                assert.equal(filter._ready, tableId === 0x8B, "保存対象とは分けて番組開始を検出します");
                assert.equal(programs.size, registered === "registered" ? 1 : 0);
                assert.equal(Object.values(status.epgByStream).some(Boolean), registered === "registered");
                assert.equal(update.mock.callCount(), registered === "registered" && tableId !== 0x8B ? 1 : 0);
            });
        }
    }
}
