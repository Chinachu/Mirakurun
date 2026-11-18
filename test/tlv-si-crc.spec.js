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
const { Writable } = require("node:stream");
const { calculateCRC32 } = require("arib-mmt-tlv-ts/crc-32.js");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0 }, errorCount: { bufferOverflow: 0 }
} } };
const eventPath = require.resolve("../lib/Mirakurun/log");
const event = { info() {}, warn() {}, error() {}, debug() {} };
require.cache[eventPath] = { id: eventPath, filename: eventPath, loaded: true, exports: event };
const _ = require("../lib/Mirakurun/_").default;
function setTunerConfig(config) { _.config = config; }
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
function fixture(t, options = {}) {
    setTunerConfig({ server: {} });
    if (options.eventId !== undefined) {
        const program = _.program;
        _.program = { get: () => null };
        t.after(() => { _.program = program; });
    }
    const written = [];
    const output = new Writable({ write(chunk, encoding, callback) { written.push(Buffer.from(chunk)); callback(); } });
    const filter = new TLVFilter({ output, parseNIT: true, ...options });
    t.after(() => { filter.close(false); output.destroy(); });
    return { filter, written };
}
function section(tableId, payload, long = true) {
    const result = Buffer.alloc(3 + payload.length + 4);
    result[0] = tableId;
    result.writeUInt16BE((long ? 0xB000 : 0x7000) | (payload.length + 4), 1);
    payload.copy(result, 3);
    result.writeUInt32BE(calculateCRC32(result.subarray(0, -4), -1) >>> 0, result.length - 4);
    assert.equal(calculateCRC32(result, -1), 0);
    return result;
}
function tlv(type, payload) {
    const header = Buffer.from([0x7F, type, 0, 0]); header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
}
function badCRC(value) { const result = Buffer.from(value); result[result.length - 1] ^= 1; return result; }
function m2(table, short = false) {
    const header = Buffer.from([0x80, short ? 2 : 0, 0, 0, 0]); header.writeUInt16BE(table.length, 3);
    return Buffer.concat([header, table]);
}
function mmtp(packetId, payload, indicator = 0, sn = 0) {
    const header = Buffer.alloc(12); header[0] = 0x40; header[1] = 2;
    header.writeUInt16BE(packetId, 2); header.writeUInt32BE(sn, 8);
    return tlv(3, Buffer.concat([Buffer.from([0, sn & 15, 0x61]), header, Buffer.from([indicator << 6, 0]), payload]));
}
const nit = () => section(0x40, Buffer.from("1234C10000F000F000", "hex"));
it("[tlv-si-crc.spec] CRC不一致のNITを破棄し、同じchunkの正常NITで初回のnetworkIdを確定する", t => {
    const { filter, written } = fixture(t);
    const network = []; filter.on("network", value => network.push(value.networkId));
    const invalid = tlv(0xFE, badCRC(nit()));
    const valid = tlv(0xFE, nit());
    filter.write(Buffer.concat([invalid, valid]));
    assert.deepEqual(network, [0x1234]);
    assert.equal(filter.closed, false);
    assert.deepEqual(Buffer.concat(written), valid);
    assert.equal(filter.streamInfo[0xFE].drop, 1);
});
const tables = [
    ["sdt", 0x8004, section(0x9F, Buffer.from("0800C10000000BFF", "hex")), false],
    ["eit", 0x8000, section(0x8B, Buffer.from("0065C100000800000B008B", "hex")), false],
    ["cdt", 0x8006, section(0xA2, Buffer.from("0001C10000000B01F00007000100010000", "hex")), false],
    ["tot", 0x8005, section(0xA1, Buffer.from("EE48123000F000", "hex"), false), true]
];
for (const [name, packetId, table, short] of tables) {
    for (const fragmented of [false, true]) {
        it(`[tlv-si-crc.spec] ${name} のCRCを再組立後・解析前に検証する (fragmented=${fragmented})`, t => {
            const { filter, written } = fixture(t);
            const received = []; filter._reader.addEventListener(name, value => received.push(value.table));
            const input = [];
            let sn = 0;
            for (const message of [m2(badCRC(table), short), m2(table, short)]) {
                if (fragmented) {
                    const split = 7;
                    input.push(mmtp(packetId, message.subarray(0, split), 1, sn++));
                    input.push(mmtp(packetId, message.subarray(split, -2), 2, sn++));
                    input.push(mmtp(packetId, message.subarray(-2), 3, sn++));
                } else { input.push(mmtp(packetId, message, 0, sn++)); }
            }
            for (const packet of input) {
                // TLV自身の分割とMMTP SIの分割を重ねても、完全なセクションだけを検証します。
                filter.write(packet.subarray(0, 5)); filter.write(packet.subarray(5));
            }
            assert.equal(received.length, 1);
            assert.equal(filter.closed, false);
            assert.equal(filter._reader.mmtStatistics().get(packetId).dropPacketCount, 1);
            // MHセクションは複数TLVにまたがり得るため、解析だけで破棄し搬送中のMMTPを書き換えません。
            assert.deepEqual(Buffer.concat(written), Buffer.concat(input));
        });
    }
}
it("[tlv-si-crc.spec] CRCのないPA/未知のshort sectionにはM2のCRC条件を課さない", t => {
    const { filter } = fixture(t);
    const mmtpReader = filter._reader.mmtpReader;
    // PA/PLTはCRCを持たない別の形式です。正当な空PLTで通知が届くことを確認します。
    const received = []; filter._reader.addEventListener("plt", value => received.push(value.table));
    const table = Buffer.from([0x80, 0, 0, 2, 0, 0]);
    const pa = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, table.length + 1, 0]), table]);
    assert.doesNotThrow(() => filter.write(Buffer.concat([mmtp(0, pa), tlv(0xFF, Buffer.alloc(0))])));
    assert.equal(received.length, 1);
    assert.equal(mmtpReader.assets.get(0).dropPacketCount, 0);
    const shortWithoutCRC = m2(Buffer.from([0xA5, 0x70, 1, 0xFF]), true);
    assert.doesNotThrow(() => filter.write(mmtp(0x8008, shortWithoutCRC)));
    assert.equal(mmtpReader.assets.get(0x8008).dropPacketCount, 0);
});
it("[tlv-si-crc.spec] CRC不一致の警告はfilterごとに一度だけ記録し、その後も正常SIを受け取る", t => {
    const { filter } = fixture(t);
    const warning = t.mock.method(event, "warn", () => {});
    const invalid = tlv(0xFE, badCRC(nit()));
    filter.write(Buffer.concat([invalid, invalid, tlv(0xFE, nit())]));
    assert.equal(warning.mock.callCount(), 1);
    assert.match(warning.mock.calls[0].arguments.join(" "), /CRC/);
    assert.equal(filter.closed, false);
});

it("[tlv-si-crc.spec] 保留1バイトの後に大きいchunkが来ても、必要な端数だけを連結する", t => {
    const { filter } = fixture(t);
    // 解析reader自身のコピーを除き、filterが連結した領域だけを測ります。
    const observed = [];
    t.mock.method(filter._reader, "push", data => { observed.push(data.length); });
    filter._readPackets(Buffer.from([0x7F]));
    const nulls = Buffer.alloc(1024 * 1024);
    for (let pos = 0; pos < nulls.length; pos += 4) { nulls.set([0x7F, 0xFF, 0, 0], pos); }
    const remainder = Buffer.concat([Buffer.from([0xFF, 0, 0]), nulls]);
    const sizes = [];
    const concat = Buffer.concat;
    t.mock.method(Buffer, "concat", (parts, length) => {
        sizes.push(length ?? parts.reduce((total, part) => total + part.length, 0));
        return concat(parts, length);
    });
    filter._readPackets(remainder);
    assert.equal(observed.reduce((total, length) => total + length, 0), nulls.length + 4);
    assert.ok(Math.max(0, ...sizes) <= 4, `filter concat sizes=${sizes}`);
    assert.equal(filter._readerBuffer, null);
});

it("[tlv-si-crc.spec] readerのreset後も同じ検証口でCRC不一致を捨て、listener失敗はcloseへ伝える", t => {
    const { filter } = fixture(t);
    const mmtpReader = filter._reader.mmtpReader;
    const check = mmtpReader.onSI;
    filter._reader.reset();
    assert.equal(filter._reader.mmtpReader, mmtpReader);
    assert.equal(mmtpReader.onSI, check);
    const [name, packetId, table] = tables[0];
    const received = []; filter._reader.addEventListener(name, value => received.push(value));
    filter.write(Buffer.concat([mmtp(packetId, m2(badCRC(table))), tlv(0xFF, Buffer.alloc(0))]));
    assert.equal(received.length, 0);
    assert.equal(mmtpReader.assets.get(packetId).dropPacketCount, 1);
    const errors = t.mock.method(event, "error", () => {});
    filter._reader.addEventListener(name, () => { throw new Error("MH-SI listener failed"); });
    assert.doesNotThrow(() => filter.write(mmtp(packetId, m2(table), 0, 1)));
    assert.equal(received.length, 1);
    assert.equal(filter.closed, true);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments.join(" "), /MH-SI listener failed/);
});

it("[tlv-si-crc.spec] TLVの宣言sectionより後のbytesをCRC未検証の受信経路として読まない", t => {
    const { filter, written } = fixture(t);
    const tables = []; filter._reader.addEventListener("nit", value => tables.push(value.table));
    // 第一sectionのCRCは正当です。後続section/paddingがあっても第一sectionの解析範囲を広げません。
    const packet = tlv(0xFE, Buffer.concat([nit(), Buffer.alloc(10)]));
    const input = Buffer.concat([packet, tlv(0xFF, Buffer.alloc(0))]);
    filter.write(input);
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].tlvStreams, []);
    assert.deepEqual(Buffer.concat(written), input);
    assert.equal(filter.closed, false);
});

for (const [tableId, payload, stat] of [[0x41, Buffer.from("1234C10000F000F000", "hex"), "TLV-NIT[other]"], [0xFE, Buffer.from("0000C100000000", "hex"), "AMT"]]) {
    it(`[tlv-si-crc.spec] ${stat} もCRC不一致だけを捨てる`, t => {
        const { filter, written } = fixture(t);
        const value = section(tableId, payload);
        const valid = tlv(0xFE, value);
        filter.write(Buffer.concat([tlv(0xFE, badCRC(value)), valid]));
        assert.equal(filter._reader.tlvStatistics().get(stat).packetCount, 1);
        assert.equal(filter.streamInfo[0xFE].drop, 1);
        assert.deepEqual(Buffer.concat(written), valid);
        assert.equal(filter.closed, false);
    });
}

for (const type of [0x02, 0x03, 0xFE, 0xFF]) {
    for (const fragmented of [false, true]) {
        it(`[tlv-si-crc.spec] 同期前の偽TLV候補を越えてCRC不一致のSIを出力しない (type=${type}, fragmented=${fragmented})`, t => {
            const { filter, written } = fixture(t);
            const bad = tlv(0xFE, badCRC(nit()));
            const good = tlv(0xFE, nit());
            // 宣言長の末尾は同期バイトではありません。途中に本物のSI列があります。
            const prefix = Buffer.from([0x12, 0x7F, type, 0x08, 0x00, 0x55]);
            const later = tlv(0xFE, section(0x40, Buffer.from("5678C10000F000F000", "hex")));
            const input = Buffer.concat([prefix, bad, good, Buffer.alloc(0x0805, 0x55), later, tlv(0xFF, Buffer.alloc(0))]);
            const network = []; filter.on("network", value => network.push(value.networkId));
            for (const chunk of fragmented ? [...input].map(byte => Buffer.from([byte])) : [input]) { filter.write(chunk); }
            const result = Buffer.concat(written);
            assert.equal(result.indexOf(bad), -1, "未検証のCRC不一致SIを出力しません");
            assert.equal(filter.streamInfo[0xFE].drop, 1);
            assert.deepEqual(network, [0x1234]);
            assert.equal(filter.closed, false);
            assert.equal(filter._rejectedPackets.size, 0);
        });
    }
}

for (const options of [{}, { parseNIT: true }, { parseSDT: true }, { parseEIT: true }, { parseNIT: true, parseSDT: true, parseEIT: true }, { serviceId: 101, eventId: 7 }]) {
    it(`[tlv-si-crc.spec] 要求した表と番組監視に必要なEITだけを再組立する (${JSON.stringify(options)})`, t => {
        const { filter } = fixture(t, { parseNIT: false, ...options });
        const target = filter._reader.eventTarget;
        const wanted = {
            nit: !!options.parseNIT,
            sdt: !!(options.parseSDT || options.parseEIT),
            cdt: !!(options.parseSDT || options.parseEIT),
            tot: !!options.parseEIT,
            eit: !!(options.parseEIT || options.eventId !== undefined),
            plt: true,
            mpt: true
        };
        for (const [name, enabled] of Object.entries(wanted)) {
            assert.equal(target.getListenerCount(name), enabled ? 1 : 0, name);
        }
        // 実際のMMTP断片の受信でも、不要な表はCRC検証口へ入る前に省きます。
        filter.write(Buffer.concat([tlv(0xFF, Buffer.alloc(0)), tlv(0xFF, Buffer.alloc(0))]));
        const mmtpReader = filter._reader.mmtpReader;
        const read = t.mock.method(mmtpReader, "onSI");
        for (const [name, packetId, table, short] of tables) {
            const message = m2(table, short);
            const split = 7;
            filter.write(mmtp(packetId, message.subarray(0, split), 1, 0));
            assert.equal(mmtpReader.siPacketQueue.has(packetId), wanted[name], name + " head");
            const before = read.mock.callCount();
            filter.write(mmtp(packetId, message.subarray(split), 3, 1));
            assert.equal(read.mock.callCount() - before, wanted[name] ? 1 : 0, name + " complete");
            assert.equal(mmtpReader.siPacketQueue.has(packetId), wanted[name], name + " retained");
        }
        assert.equal(filter.closed, false);
    });
}

it("[tlv-si-crc.spec] 未確認の偽ヘッダーをreaderへ渡さず、最初の正常なNITを採用する", t => {
    const { filter } = fixture(t);
    const first = tlv(0xFE, nit());
    const later = tlv(0xFE, section(0x40, Buffer.from("5678C10000F000F000", "hex")));
    const nil = tlv(0xFF, Buffer.alloc(0));
    const chunks = [], networks = [];
    filter.on("network", network => networks.push(network.networkId));
    const push = filter._reader.push.bind(filter._reader);
    t.mock.method(filter._reader, "push", chunk => { chunks.push(Buffer.from(chunk)); return push(chunk); });
    filter.write(Buffer.concat([Buffer.from("127FFF080055", "hex"), first, nil, Buffer.alloc(0x0805, 0x55), later, nil]));
    assert.deepEqual(networks, [0x1234]);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, nil, later, nil]));
    assert.equal(filter.closed, false);
});


for (const serviceId of [undefined, 1]) {
    for (const fragmented of [false, true]) {
        for (const type of [0x00, 0x04, 0x7F]) {
            it(`[tlv-si-crc.spec] 同期中の未定義種別でも解析と出力を同じ境界へ戻す (type=${type}, fragmented=${fragmented}, serviceId=${serviceId})`, t => {
                const { filter, written } = fixture(t, { serviceId });
                if (serviceId !== undefined) {
                    const packageTable = (id, body) => {
                        const head = Buffer.from([id, 0, 0, 0]); head.writeUInt16BE(body.length, 2);
                        return Buffer.concat([head, body]);
                    };
                    const pa = (packetId, table) => {
                        const extension = Buffer.concat([Buffer.from([1]), table.subarray(0, 4), table]);
                        const head = Buffer.alloc(7); head.writeUInt32BE(extension.length, 3);
                        return mmtp(packetId, Buffer.concat([head, extension]));
                    };
                    const plt = packageTable(0x80, Buffer.from([1, 2, 0, 1, 0, 0, 0x10, 0]));
                    const mpt = packageTable(0x20, Buffer.from([0xFF, 2, 0, 1, 0, 0, 1,
                        0, 0, 0, 0, 0, 2, 0, 0, 0x68, 0x65, 0x76, 0x31, 0xFE, 1, 0, 1, 0, 0, 0]));
                    filter.write(Buffer.concat([pa(0, plt), pa(0x10, mpt)]));
                } else { filter.write(Buffer.concat([tlv(0xFF, Buffer.alloc(0)), tlv(0xFF, Buffer.alloc(0))])); }
                assert.equal(filter._ready, true);
                written.length = 0;
                const network = []; filter.on("network", value => network.push(value.networkId));
                const bad = tlv(0xFE, badCRC(nit()));
                const good = tlv(0xFE, nit());
                // 0x7Fが重なる場合、次のバイトが本物の同期です。それ以外は偽の宣言長にSIが入っています。
                const broken = type === 0x7F ? Buffer.concat([Buffer.from([0x7F]), bad]) : tlv(type, bad);
                const media = tlv(0x01, Buffer.from("4500000811223344", "hex"));
                const tail = tlv(0xFF, Buffer.alloc(0));
                const input = Buffer.concat([broken, good, media, tail]);
                for (const chunk of fragmented ? [...input].map(byte => Buffer.from([byte])) : [input]) { filter.write(chunk); }
                filter.flush();
                const result = Buffer.concat(written);
                assert.deepEqual(result, Buffer.concat([good, media, tail]));
                assert.equal(result.indexOf(bad), -1, "未定義種別の宣言長でCRC不一致SIを包んで出力しません");
                assert.deepEqual(network, [0x1234]);
                assert.equal(filter.streamInfo[0xFE].drop, 1);
                assert.equal(filter.streamInfo[type], undefined, "未定義種別を正常なTLVとして数えません");
                assert.equal(filter._rejectedPackets.size, 0);
                assert.equal(filter._readerBuffer, null);
                assert.equal(filter._countBuffer, null);
                assert.equal(filter.closed, false);
            });
        }
    }
}

it("[tlv-si-crc.spec] 正当なIPv4の内部に未定義種別らしいbytesがあっても再同期しない", t => {
    const { filter, written } = fixture(t);
    const media = tlv(0x01, Buffer.concat([Buffer.from([0x45, 0, 0x7F, 0x04, 0, 4]), tlv(0xFE, badCRC(nit()))]));
    const tail = tlv(0xFF, Buffer.alloc(0));
    filter.write(Buffer.concat([media, tail]));
    assert.deepEqual(Buffer.concat(written), Buffer.concat([media, tail]));
    assert.equal(filter.streamInfo[0x01].packet, 1);
    assert.equal(filter.streamInfo[0xFE], undefined);
    assert.equal(filter.closed, false);
});
