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
const status = { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0 } };
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: status } };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const eventPath = require.resolve("../lib/Mirakurun/log");
require.cache[eventPath] = { id: eventPath, filename: eventPath, loaded: true, exports: logger };
const _ = require("../lib/Mirakurun/_").default;

const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
const Service = require("../lib/Mirakurun/Service").default;
const TunerDevice = require("../lib/Mirakurun/TunerDevice").default;
const si = Buffer.from("7FFE000180", "hex");
const nil = Buffer.from("7FFF0000", "hex");
const empty = Buffer.from("7FFE0000", "hex");
function fixture(t, options = {}) {
    _.config = { server: {} };
    const written = [];
    const output = new Writable({ write(chunk, _encoding, callback) { written.push(Buffer.from(chunk)); callback(); } });
    const filter = new TLVFilter({ output, ...options });
    t.after(() => { filter.close(false); output.destroy(); });
    return { filter, written };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
for (const count of [512, 2048]) {
    it(`[tlv-filter-resources.spec] 空SI除去のコピー量は入力長に比例する (packets=${count})`, t => {
        const { filter, written } = fixture(t);
        const input = Buffer.concat(Array.from({ length: count }, () => Buffer.concat([si, empty, nil])));
        const expected = Buffer.concat(Array.from({ length: count }, () => Buffer.concat([si, nil])));
        const original = Buffer.concat;
        let copied = 0;
        const concat = t.mock.method(Buffer, "concat", (list, length) => {
            copied += length ?? list.reduce((sum, chunk) => sum + chunk.length, 0);
            return original(list, length);
        });
        filter.write(input);
        filter.flush();
        const calls = concat.mock.callCount();
        concat.mock.restore();
        assert.deepEqual(Buffer.concat(written), expected);
        assert.ok(copied <= input.length * 4, `コピー量${copied}bytesが入力${input.length}bytesに対して増え過ぎています`);
        assert.ok(calls <= 4, `パケットごとに再連結しています (concat=${calls})`);
    });
}
it("[tlv-filter-resources.spec] 連続した正常パケットは連結コピーしない", t => {
    const { filter, written } = fixture(t);
    const input = Buffer.concat([si, nil, si, nil]);
    const concat = t.mock.method(Buffer, "concat");
    filter.write(input);
    assert.equal(concat.mock.callCount(), 0);
    assert.deepEqual(written, [input]);
});
it("[tlv-filter-resources.spec] listener失敗は当filterだけ閉じ、後続userも同じchunkを受信してflushする", async t => {
    const { filter: failed } = fixture(t, { parseNIT: true });
    const { filter: healthy, written } = fixture(t);
    const expected = new Error("saved metadata listener failure");
    const errors = t.mock.method(logger, "error", () => {});
    failed.on("network", () => { throw expected; });
    const reader = failed._reader;
    t.mock.method(reader, "push", () => reader.eventTarget.dispatchEvent("nit", {
        table: { tableId: "TLV-NIT[actual]", networkId: 11, networkDescriptors: [] }
    }));
    const device = Object.create(TunerDevice.prototype);
    const first = { _stream: failed };
    Object.assign(device, { _users: new Set([first, { _stream: healthy }]), _spawnedAt: 0, _pendingBytes: 0, _flushTimer: null });
    device._flushUsersBound = device._flushUsers.bind(device);
    failed.on("close", () => device._users.delete(first));
    t.after(() => { device._flushUsers(); device._users.clear(); });
    const entered = deferred(), gate = deferred();
    const input = Buffer.concat([si, nil]);
    const delivery = Promise.resolve().then(async () => {
        entered.resolve(); await gate.promise;
        device._streamOnData(input);
        device._flushUsers();
    });
    try {
        await entered.promise;
        assert.equal(written.length, 0);
        gate.resolve();
        await assert.doesNotReject(delivery);
        assert.equal(failed.closed, true);
        assert.equal(healthy.closed, false);
        assert.deepEqual(Buffer.concat(written), input);
        assert.equal(errors.mock.callCount(), 1);
        assert.match(errors.mock.calls[0].arguments.join(" "), /saved metadata listener failure/);
        assert.equal(reader.buffer.length, 0);
        assert.equal(device._users.size, 1);
    } finally { gate.resolve(); await delivery.catch(() => {}); }
});
it("[tlv-filter-resources.spec] 同じreader.push内でもclose後にEIT処理やEPG所有権を復活させない", t => {
    const { filter } = fixture(t, { parseNIT: true, parseEIT: true });
    const reader = filter._reader;
    filter._serviceIds.add(101);
    filter.on("network", () => filter.close(false));
    const target = reader.eventTarget;
    const eit = { currentNextIndicator: true, tableId: "EIT[p/f]", serviceId: 101, originalNetworkId: 11, tlvStreamId: 0x800, events: [] };
    t.mock.method(reader, "push", () => {
        target.dispatchEvent("nit", { table: { tableId: "TLV-NIT[actual]", networkId: 11, networkDescriptors: [] } });
        target.dispatchEvent("eit", { table: eit });
    });
    t.after(() => { filter._epg?.end(); filter._epg = undefined; for (const key of Object.keys(status.epgByStream)) { delete status.epgByStream[key]; } });
    assert.doesNotThrow(() => filter.write(Buffer.concat([si, nil])));
    assert.equal(filter.closed, true);
    assert.equal(filter._epg, undefined);
    assert.equal(Object.values(status.epgByStream).includes(true), false);
});
function sdt(logoIds, version = 1, sections = 2) {
    return {
        tableId: "SDT[actual]", originalNetworkId: 11, tlvStreamId: 0x800,
        services: logoIds.map(logoId => ({ serviceId: logoId + 100, freeCAMode: false, descriptors: [{
            tag: "mhLogoTransmission", logoTransmissionType: 1, logoId, logoVersion: version,
            logoList: [{ logoType: 7, startSectionNumber: 0, numOfSections: sections }]
        }] }))
    };
}
function cdt(logoId, data, sectionNumber = 0, version = 1) {
    return { dataType: 1, originalNetworkId: 11, sectionNumber, dataModule: { logoType: 7, logoId, logoVersion: version, data } };
}
function register(filter, ids, version = 1, sections = 2) {
    for (const id of ids) { filter._serviceIds.add(id + 100); }
    filter._onSDT(sdt(ids, version, sections));
}
function retained(filter) { return [...filter._logoTransmissions.values()].reduce((bytes, trans) => bytes + trans.data.reduce((sum, data) => sum + (data?.byteLength ?? 0), 0), 0); }
it("[tlv-filter-resources.spec] MH-CDTの保持対象は64件まで、超過してもservice情報は通知する", t => {
    const { filter } = fixture(t, { parseSDT: true });
    const services = t.mock.fn(); filter.on("services", services);
    const warns = t.mock.method(logger, "warn", () => {});
    register(filter, Array.from({ length: 1000 }, (_, i) => i));
    assert.equal(filter._logoTransmissions.size, 64);
    assert.equal(services.mock.calls[0].arguments[0].length, 1000);
    assert.equal(warns.mock.callCount(), 1);
    filter.close();
    assert.equal(filter._logoTransmissions.size, 0);
});
it("[tlv-filter-resources.spec] MH-CDT全体の未完成ロゴは16MiBを超えず、重複sectionを再保持しない", t => {
    const { filter } = fixture(t, { parseSDT: true });
    const warns = t.mock.method(logger, "warn", () => {});
    const ids = Array.from({ length: 5 }, (_, i) => i);
    register(filter, ids, 1, 255);
    const part = Buffer.alloc(65530, 0xA5);
    for (const id of ids) {
        for (let section = 0; section < 65; ++section) { filter._onCDT(cdt(id, part, section)); }
    }
    const bytes = retained(filter);
    assert.ok(bytes <= 16 * 1024 * 1024, `保持量が上限を超えました: ${bytes}`);
    assert.ok(bytes > 15 * 1024 * 1024);
    filter._onCDT(cdt(0, part));
    assert.equal(retained(filter), bytes);
    assert.equal(warns.mock.callCount(), 1);
    filter.close();
    assert.equal(retained(filter), 0);
});
it("[tlv-filter-resources.spec] 小さなMH-CDT断片のために元の大きな入力bufferを保持しない", t => {
    const { filter } = fixture(t, { parseSDT: true });
    register(filter, [1]);
    const original = Buffer.alloc(1024 * 1024, 0x5A);
    const part = original.subarray(500, 510);
    filter._onCDT(cdt(1, part));
    const saved = filter._logoTransmissions.get(1).data[0];
    assert.notEqual(saved.buffer, original.buffer);
    assert.equal(saved.buffer.byteLength, part.byteLength);
    original.fill(0);
    assert.deepEqual(Buffer.from(saved), Buffer.alloc(10, 0x5A));
});
it("[tlv-filter-resources.spec] MH-CDTは完了・version更新・closeで保持量を解放し、後続ロゴも保存する", t => {
    const { filter } = fixture(t, { parseSDT: true });
    const saved = t.mock.method(Service, "saveLogoData", async () => {});
    register(filter, [1, 2]);
    filter._onCDT(cdt(1, Buffer.from([1, 2]), 0));
    filter._onCDT(cdt(2, Buffer.from([9]), 0));
    assert.equal(retained(filter), 3);
    filter._onCDT(cdt(1, Buffer.from([3, 4]), 1));
    assert.equal(retained(filter), 1);
    assert.deepEqual(saved.mock.calls[0].arguments.slice(0, 3), [11, 1, Buffer.from([1, 2, 3, 4])]);
    register(filter, [2], 2);
    assert.equal(retained(filter), 0);
    filter._onCDT(cdt(2, Buffer.from([8]), 0, 1));
    assert.equal(retained(filter), 0);
    filter._onCDT(cdt(2, Buffer.from([5]), 0, 2));
    filter._onCDT(cdt(2, Buffer.from([6]), 1, 2));
    assert.deepEqual(saved.mock.calls[1].arguments.slice(0, 3), [11, 2, Buffer.from([5, 6])]);
    assert.equal(retained(filter), 0);
    filter.close(); assert.equal(filter._logoTransmissions.size, 0);
});

it("[tlv-filter-resources.spec] MH-CDTロゴの保存失敗を記録し、受信と別ロゴの保存を継続する", async t => {
    const { filter } = fixture(t, { parseSDT: true });
    const expected = new Error("logo storage unavailable");
    let rejectSave;
    const failed = new Promise((_resolve, reject) => { rejectSave = reject; });
    const saved = t.mock.method(Service, "saveLogoData", (_networkId, logoId) => logoId === 1 ? failed : Promise.resolve());
    const warns = t.mock.method(logger, "warn", () => {});
    register(filter, [1, 2], 1, 1);
    filter._onCDT(cdt(1, Buffer.from([1, 2])));
    assert.equal(saved.mock.callCount(), 1);
    assert.equal(warns.mock.callCount(), 0);
    rejectSave(expected);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warns.mock.callCount(), 1);
    assert.match(warns.mock.calls[0].arguments[0], /ロゴデータを保存できませんでした/);
    assert.deepEqual(warns.mock.calls[0].arguments.slice(1), [11, 1, "logo storage unavailable"]);
    assert.equal(filter.closed, false);
    filter._onCDT(cdt(2, Buffer.from([3, 4])));
    assert.equal(saved.mock.callCount(), 2);
    assert.deepEqual(saved.mock.calls[1].arguments.slice(0, 3), [11, 2, Buffer.from([3, 4])]);
    assert.equal(retained(filter), 0);
});

for (const defer of [false, true]) {
    for (const chunkSize of [262143, 1048573]) {
        it(`[tlv-filter-resources.spec] パケット境界をまたぐ入力は端数だけをコピーする (chunk=${chunkSize}, defer=${defer})`, t => {
            _.config = { server: {} };
            const packet = Buffer.alloc(1007, 0x11);
            packet.set([0x7F, 0x01, 0x03, 0xEB]);
            const count = 9000;
            const input = Buffer.concat(Array(count).fill(packet));
            const written = [];
            const output = new Writable({ write(chunk, _encoding, callback) { written.push(chunk); callback(); } });
            const filter = new TLVFilter({ output });
            t.after(() => { filter.close(false); output.destroy(); });
            const originalConcat = Buffer.concat, originalCopy = Buffer.prototype.copy, originalFrom = Buffer.from;
            let copied = 0;
            const mocks = [
                t.mock.method(Buffer, "concat", (chunks, length) => {
                    copied += length ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                    return originalConcat(chunks, length);
                }),
                t.mock.method(Buffer.prototype, "copy", function(...args) {
                    const bytes = originalCopy.apply(this, args); copied += bytes; return bytes;
                }),
                t.mock.method(Buffer, "from", function(source, ...args) {
                    if (Buffer.isBuffer(source)) { copied += source.length; }
                    return originalFrom.call(this, source, ...args);
                })
            ];
            try {
                for (let start = 0; start < input.length; start += chunkSize) {
                    filter.write(input.subarray(start, start + chunkSize), defer);
                    filter.flush();
                    assert.ok((filter._countBuffer?.length ?? 0) <= 65539);
                }
            } finally { for (const mock of mocks) { mock.mock.restore(); } }
            assert.ok(copied < input.length / 10, `入力${input.length}bytesのうち${copied}bytesをコピーしました`);
            assert.deepEqual(Buffer.concat(written), input, "以前に渡した出力viewも変更しません");
            assert.deepEqual(filter.streamInfo[0x01], { packet: count, drop: 0 });
            assert.equal(filter._countBuffer, null);
            filter.close(false);
            assert.equal(filter._countStorage ?? null, null);
        });
    }
}

it("[tlv-filter-resources.spec] 出力writeが同期的に失敗してもcorkを解除し、既存の例外を返す", t => {
    const { filter } = fixture(t);
    const output = filter._output;
    const expected = new Error("write failed");
    const write = t.mock.method(output, "write", () => { throw expected; });
    assert.throws(() => filter.write(Buffer.concat([si, nil])), error => error === expected);
    assert.equal(output.writableCorked, 0);
    assert.equal(filter.closed, false);
    write.mock.restore();
});
