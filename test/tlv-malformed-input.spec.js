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
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0 }
} } };
const eventPath = require.resolve("../lib/Mirakurun/log");
const event = { info() {}, warn() {}, error() {}, debug() {} };
require.cache[eventPath] = { id: eventPath, filename: eventPath, loaded: true, exports: event };
const _ = require("../lib/Mirakurun/_").default;
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
const bad = Buffer.from([0x7F, 0xFE, 0, 0]);
const si = Buffer.from([0x7F, 0xFE, 0, 1, 0x80]);
const nil = Buffer.from([0x7F, 0xFF, 0, 0]);
function fixture(t, output = true, options = {}) {
    _.config = { server: {} };
    const written = [];
    const sink = new Writable({ write(chunk, encoding, callback) { written.push(Buffer.from(chunk)); callback(); } });
    const filter = new TLVFilter({ ...(output && { output: sink }), ...options });
    t.after(() => { filter.close(false); sink.destroy(); });
    return { filter, written };
}
for (const fragmented of [false, true]) {
    it(`[tlv-malformed-input.spec] 空の制御パケットだけを捨て、前後の正常パケットを継続する (fragmented=${fragmented})`, t => {
        const { filter, written } = fixture(t);
        const input = Buffer.concat([si, bad, nil, bad, si, nil]);
        const chunks = fragmented ? [...input].map(byte => Buffer.from([byte])) : [input];
        for (const chunk of chunks) { assert.doesNotThrow(() => filter.write(chunk)); }
        filter.flush();
        assert.equal(filter.closed, false);
        assert.deepEqual(Buffer.concat(written), Buffer.concat([si, nil, si, nil]));
        assert.equal(filter._reader.tlvStatistics().get("80").packetCount, 2);
    });
}
it("[tlv-malformed-input.spec] 出力が無いEPG解析も壊れた制御パケットの後に復帰する", t => {
    const { filter } = fixture(t, false);
    for (const chunk of [bad.subarray(0, 2), bad.subarray(2), si]) { assert.doesNotThrow(() => filter.write(chunk)); }
    assert.equal(filter.closed, false);
    assert.equal(filter._reader.tlvStatistics().get("80").packetCount, 1);
});
it("[tlv-malformed-input.spec] 空のSIが続いても警告を増やさず、正常な後続パケットを渡す", t => {
    const { filter, written } = fixture(t);
    const warn = t.mock.method(event, "warn", () => {});
    assert.doesNotThrow(() => filter.write(Buffer.concat([nil, bad, si, bad, nil])));
    filter.flush();
    assert.deepEqual(Buffer.concat(written), Buffer.concat([nil, si, nil]));
    assert.equal(warn.mock.callCount(), 1);
});
it("[tlv-malformed-input.spec] reader内部の例外は記録して閉じ、壊れたbufferを保持しない", t => {
    const { filter } = fixture(t);
    const reader = filter._reader;
    const expected = new Error("unexpected reader failure");
    const error = t.mock.method(event, "error", () => {});
    t.mock.method(reader, "push", () => { throw expected; });
    assert.doesNotThrow(() => filter.write(Buffer.concat([si, nil])));
    assert.equal(filter.closed, true);
    assert.equal(reader.buffer.length, 0);
    assert.equal(error.mock.callCount(), 1);
    assert.match(error.mock.calls[0].arguments.join(" "), /unexpected reader failure/);
});

const malformedNIT = Buffer.from("7FFE000A40B0070001C10000F000", "hex");
const validNIT = Buffer.from("7FFE001040B00D000BC10000F000F00000000000", "hex");
const { calculateCRC32 } = require("arib-mmt-tlv-ts/crc-32.js");
validNIT.writeUInt32BE(calculateCRC32(validNIT.subarray(4, -4), -1) >>> 0, validNIT.length - 4);
// 圧縮IPヘッダー0x61 + MMTP packet_id 0x0100のMPU payload（周辺selector試験と同じ構造）。
const media = Buffer.alloc(4 + 3 + 12 + 10);
media.set([0x7F, 0x03, 0, media.length - 4, 0, 1, 0x61, 0x40, 0, 1, 0]);
for (const output of [false, true]) {
    for (const fragmented of [false, true]) {
        it(`[tlv-malformed-input.spec] 不正NITだけを除外し同じchunkの前後・次write・共有利用者への配信を続ける (output=${output}, fragmented=${fragmented})`, t => {
            const { filter, written } = fixture(t, output, { parseNIT: true });
            const reader = filter._reader;
            const reset = t.mock.method(reader, "reset");
            const errors = t.mock.method(event, "error", () => {});
            const warnings = t.mock.method(event, "warn", () => {});
            const closes = t.mock.fn(); filter.on("close", closes);
            const context = { bytes: 0, packets: 0, dropPacketCount: 0, context: { cid: 999 }, sequenceNumber: 0 };
            reader.contexts.set(999, context);
            const input = Buffer.concat([validNIT, media, malformedNIT, si, nil, malformedNIT, media, validNIT]);
            const expected = Buffer.concat([validNIT, media, si, nil, media, validNIT]);
            let forwarded = 0;
            const users = [filter, { write(chunk) { forwarded += chunk.length; } }];
            for (const chunk of fragmented ? [...input].map(byte => Buffer.from([byte])) : [input]) {
                assert.doesNotThrow(() => { for (const user of users) { user.write(chunk); } });
            }
            filter.write(Buffer.concat([si, nil]));
            filter.flush();
            assert.equal(forwarded, input.length);
            assert.equal(filter.closed, false);
            assert.equal(reader.contexts.get(999), context, "既存のreader contextを初期化しません");
            assert.equal(reader.contexts.get(0)?.packets, 2, "不正SIの前後のMMTP contextを引き継ぎます");
            assert.equal(reader.siStatistics.get("TLV-NIT[actual]")?.packetCount, 2);
            assert.equal(reader.siStatistics.get("80")?.packetCount, 2);
            assert.equal(filter._remoteControlKeyIdMap.size, 0);
            assert.equal(reset.mock.callCount(), 0);
            assert.equal(closes.mock.callCount(), 0);
            assert.equal(errors.mock.callCount(), 0);
            assert.equal(warnings.mock.callCount(), 1);
            assert.equal(filter._rejectedPackets.size, 0);
            assert.deepEqual(Buffer.concat(written), output ? Buffer.concat([expected, si, nil]) : Buffer.alloc(0));
        });
    }
}
it("[tlv-malformed-input.spec] 正常NITの利用者callbackがRangeErrorを出した場合は原因を記録して閉じる", t => {
    const { filter } = fixture(t, true, { parseNIT: true });
    const errors = t.mock.method(event, "error", () => {});
    const warnings = t.mock.method(event, "warn", () => {});
    filter.on("network", () => { throw new RangeError("saved network listener failed"); });
    assert.doesNotThrow(() => filter.write(Buffer.concat([validNIT, nil])));
    assert.equal(filter.closed, true);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments.join(" "), /saved network listener failed/);
    assert.equal(warnings.mock.callCount(), 0, "保存処理の例外を受信パケットの破損として扱いません");
});

it("[tlv-malformed-input.spec] 呼出元listenerの失敗は原因を記録して当filterだけ閉じる", t => {
    const { filter } = fixture(t, true, { parseNIT: true });
    const expected = new Error("listener failed");
    const errors = t.mock.method(event, "error", () => {});
    filter._parseNIT = true;
    filter.on("network", () => { throw expected; });
    t.mock.method(filter._reader, "push", () => filter._reader.eventTarget.dispatchEvent("nit", {
        table: { tableId: "TLV-NIT[actual]", networkId: 11, networkDescriptors: [] }
    }));
    assert.doesNotThrow(() => filter.write(Buffer.concat([si, nil])));
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments.join(" "), /listener failed/);
    assert.equal(filter.closed, true);
});

it("[tlv-malformed-input.spec] サービス選択を行う出力にも解析拒否したパケットを流さない", t => {
    _.config = { server: {} };
    const written = [];
    const output = new Writable({ write(chunk, encoding, callback) { written.push(Buffer.from(chunk)); callback(); } });
    const filter = new TLVFilter({ output, serviceId: 101 });
    t.after(() => { filter.close(false); output.destroy(); });
    filter._ready = true;
    assert.doesNotThrow(() => filter.write(Buffer.concat([si, bad, nil, si])));
    filter.flush();
    assert.deepEqual(Buffer.concat(written), Buffer.concat([si, nil, si]));
});

it("[tlv-malformed-input.spec] 解析イベントでcloseした後に入力末尾のbufferを作り直さない", t => {
    const { filter } = fixture(t, true, { parseNIT: true });
    filter.on("network", () => filter.close(false));
    t.mock.method(filter._reader, "push", () => filter._reader.eventTarget.dispatchEvent("nit", {
        table: { tableId: "TLV-NIT[actual]", networkId: 11, networkDescriptors: [] }
    }));
    filter.write(Buffer.concat([si, Buffer.from([0x7F, 0xFE])]));
    assert.equal(filter.closed, true);
    assert.equal(filter._readerBuffer, null);
    assert.equal(filter._countBuffer, null);
    assert.equal(filter._rejectedPackets.size, 0);
});

for (const mode of ["channel", "service", "metadata"]) {
    for (const fragmented of [false, true]) {
        it(`[tlv-malformed-input.spec] IPv4内の疑似SIを保持し、解析には対応する後続TLVだけを渡す (${mode}, fragmented=${fragmented})`, t => {
            const { filter, written } = fixture(t, mode !== "metadata", mode === "service" ? { serviceId: 101 } : {});
            if (mode === "service") { filter._ready = true; }
            const ipv4 = Buffer.from("7F0100087FFE000011223344", "hex");
            const readerInput = [];
            const push = filter._reader.push.bind(filter._reader);
            t.mock.method(filter._reader, "push", chunk => { readerInput.push(Buffer.from(chunk)); return push(chunk); });
            const warn = t.mock.method(event, "warn", () => {});
            const input = Buffer.concat([si, bad, ipv4, nil, bad, si]);
            for (const chunk of fragmented ? [...input].map(byte => Buffer.from([byte])) : [input]) {
                assert.doesNotThrow(() => filter.write(chunk));
            }
            filter.flush();
            // 依存readerはIPv4未対応。payloadをTLVとして走査させず、解析できるパケットだけを渡す。
            assert.deepEqual(Buffer.concat(readerInput), Buffer.concat([si, nil, si]));
            assert.equal(filter._reader.tlvStatistics().get("80").packetCount, 2);
            assert.deepEqual(Buffer.concat(written), mode === "metadata" ? Buffer.alloc(0) : Buffer.concat([si, ipv4, nil, si]));
            assert.equal(warn.mock.callCount(), 1);
            assert.equal(filter._rejectedPackets.size, 0);
        });
    }
}

for (const fragmented of [false, true]) {
    it(`[tlv-malformed-input.spec] 未同期の偽IPv4候補の末尾が合わなければ保持したSIへ戻る (fragmented=${fragmented})`, t => {
        const { filter, written } = fixture(t);
        const expected = Buffer.concat([si, nil, si, nil]);
        const input = Buffer.concat([Buffer.from("127F010040", "hex"), expected, Buffer.alloc(96, 0x12)]);
        for (const chunk of fragmented ? [...input].map(byte => Buffer.from([byte])) : [input]) { filter.write(chunk); }
        assert.equal(filter.closed, false);
        assert.equal(filter._reader.tlvStatistics().get("80")?.packetCount, 2);
        assert.deepEqual(Buffer.concat(written), expected);
        assert.equal(filter._rejectedPackets.size, 0);
    });
}
function ipv4WithEmbeddedSI() {
    const payload = Buffer.alloc(40, 0x12);
    payload[0] = 0x45;
    payload.writeUInt16BE(payload.length, 2);
    Buffer.concat([bad, si, nil]).copy(payload, 20);
    const header = Buffer.from([0x7F, 0x01, 0, payload.length]);
    return Buffer.concat([header, payload]);
}
it("[tlv-malformed-input.spec] 真のIPv4内部の疑似SIを全chunk分割位置で解析・除去しない", t => {
    const ipv4 = ipv4WithEmbeddedSI();
    const input = Buffer.concat([ipv4, si, bad, nil]);
    for (const split of Array.from({ length: input.length - 1 }, (_, i) => i + 1)) {
        const { filter, written } = fixture(t);
        filter.write(input.subarray(0, split));
        filter.write(input.subarray(split));
        assert.equal(filter.closed, false, `split=${split}`);
        assert.equal(filter._reader.tlvStatistics().get("80")?.packetCount, 1, `split=${split}`);
        assert.deepEqual(Buffer.concat(written), Buffer.concat([ipv4, si, nil]), `split=${split}`);
        assert.equal(filter._rejectedPackets.size, 0, `split=${split}`);
    }
});
it("[tlv-malformed-input.spec] 未同期IPv4は宣言末尾が来るまで内部の疑似SIへ同期しない", t => {
    const { filter, written } = fixture(t);
    const ipv4 = ipv4WithEmbeddedSI();
    for (const byte of ipv4) {
        filter.write(Buffer.from([byte]));
        assert.equal(written.length, 0);
        assert.equal(filter._reader.tlvStatistics().get("80"), undefined);
    }
    filter.write(Buffer.concat([si, nil]));
    assert.deepEqual(Buffer.concat(written), Buffer.concat([ipv4, si, nil]));
    assert.equal(filter._reader.tlvStatistics().get("80")?.packetCount, 1);
});
it("[tlv-malformed-input.spec] 最大長の未同期IPv4は65539bytes以下で保持し、次の境界で元のまま出力する", t => {
    const { filter, written } = fixture(t);
    const payload = Buffer.alloc(65535, 0x12);
    payload[0] = 0x45;
    payload.writeUInt16BE(payload.length, 2);
    Buffer.concat([bad, si, nil]).copy(payload, 300);
    const ipv4 = Buffer.concat([Buffer.from("7F01FFFF", "hex"), payload]);
    for (const chunk of [ipv4.subarray(0, 1), ipv4.subarray(1, 4), ipv4.subarray(4, 4097), ipv4.subarray(4097)]) {
        filter.write(chunk);
        assert.ok((filter._readerBuffer?.length ?? 0) <= 65539);
        assert.ok((filter._countBuffer?.length ?? 0) <= 65539);
    }
    assert.equal(written.length, 0);
    assert.equal(filter._reader.tlvStatistics().get("80"), undefined);
    for (const byte of si) { filter.write(Buffer.from([byte])); }
    assert.deepEqual(Buffer.concat(written), Buffer.concat([ipv4, si]));
    assert.equal(filter._reader.tlvStatistics().get("80")?.packetCount, 1);
});
it("[tlv-malformed-input.spec] TSMF由来の既知境界ではIPv4の次パケットを待たない", t => {
    const { filter, written } = fixture(t, true, { tsmfRelTs: 1 });
    filter._tsmf = { push: chunk => chunk };
    const ipv4 = ipv4WithEmbeddedSI();
    filter.write(ipv4);
    assert.deepEqual(Buffer.concat(written), ipv4);
    assert.equal(filter._readerBuffer, null);
    assert.equal(filter._reader.tlvStatistics().get("80"), undefined);
});
it("[tlv-malformed-input.spec] 保留末尾のために元の大きなchunkを参照し続けない", t => {
    const { filter } = fixture(t);
    const input = Buffer.alloc(1024 * 1024, 0x12);
    input[input.length - 1] = 0x7F;
    filter.write(input);
    assert.equal(filter._readerBuffer.length, 1);
    assert.notEqual(filter._readerBuffer.buffer, input.buffer);
    assert.notEqual(filter._countBuffer.buffer, input.buffer);
});

it("[tlv-malformed-input.spec] 同期済みでも境界外のchunkで同期を外し、偽IPv4からSIを復旧する", t => {
    const { filter, written } = fixture(t);
    const packets = Buffer.concat([si, nil]);
    filter.write(packets);
    filter.write(Buffer.from([0x12]));
    filter.write(Buffer.concat([Buffer.from("7F010040", "hex"), packets, Buffer.alloc(96, 0x12)]));
    assert.equal(filter._reader.tlvStatistics().get("80")?.packetCount, 2);
    assert.deepEqual(Buffer.concat(written), Buffer.concat([packets, packets]));
});
it("[tlv-malformed-input.spec] 出力のない解析も偽IPv4の末尾不一致後にSIを復旧する", t => {
    const { filter } = fixture(t, false);
    filter.write(Buffer.concat([Buffer.from("127F010040", "hex"), si, nil, Buffer.alloc(96, 0x12)]));
    assert.equal(filter._reader.tlvStatistics().get("80")?.packetCount, 1);
});

it("[tlv-malformed-input.spec] 先行する未完了非IPv4の保留位置をpayload内のIPv4候補で上書きしない", t => {
    const { filter, written } = fixture(t);
    const payload = Buffer.alloc(200, 0x12);
    payload[0] = 0x80;
    Buffer.from("7F010040", "hex").copy(payload, 10);
    const packet = Buffer.concat([Buffer.from("7FFE00C8", "hex"), payload]);
    filter.write(packet.subarray(0, 34));
    assert.equal(written.length, 0);
    filter.write(Buffer.concat([packet.subarray(34), si, nil]));
    assert.equal(filter.closed, false);
    assert.equal(filter._reader.tlvStatistics().get("80")?.packetCount, 2);
    assert.deepEqual(Buffer.concat(written), Buffer.concat([packet, si, nil]));
});

for (const fragmented of [false, true]) {
    it(`[tlv-malformed-input.spec] 長い偽IPv4候補の連続でも保留のコピー量は入力長に比例する (fragmented=${fragmented})`, t => {
        const { filter } = fixture(t, false);
        const initial = Buffer.alloc(65539);
        const tail = Buffer.alloc(8192);
        for (let i = 0; i < initial.length; ++i) { initial[i] = [0x7F, 0x01, 0xFF, 0xFF][i % 4]; }
        for (let i = 0; i < tail.length; ++i) { tail[i] = [0x7F, 0x01, 0xFF, 0xFF][(initial.length + i) % 4]; }
        const originalConcat = Buffer.concat, originalCopy = Buffer.prototype.copy;
        let copied = 0;
        const concat = t.mock.method(Buffer, "concat", (list, length) => {
            copied += length ?? list.reduce((sum, item) => sum + item.length, 0);
            return originalConcat(list, length);
        });
        const copy = t.mock.method(Buffer.prototype, "copy", function(...args) {
            const bytes = originalCopy.apply(this, args); copied += bytes; return bytes;
        });
        filter.write(initial);
        for (let i = 0; i < tail.length; i += fragmented ? 4 : tail.length) {
            filter.write(tail.subarray(i, Math.min(tail.length, i + (fragmented ? 4 : tail.length))));
        }
        concat.mock.restore(); copy.mock.restore();
        assert.ok(copied < (initial.length + tail.length) * 8, `保留の再コピーが増え過ぎています (${copied}bytes)`);
        assert.ok((filter._readerBuffer?.length ?? 0) <= 65539);
        assert.ok((filter._readerStorage?.length ?? 0) <= 2 * 65540);
        assert.equal(filter.closed, false);
        // 偽候補の宣言末尾を越えてから来る実パケットへ復旧できることも確認する。
        filter.write(Buffer.concat([Buffer.alloc(65540, 0x12), si, nil]));
        assert.equal(filter._reader.tlvStatistics().get("80")?.packetCount, 1);
        filter.close(false);
        assert.equal(filter._readerBuffer, null);
        assert.equal(filter._readerStorage, null);
    });
}

it("[tlv-malformed-input.spec] 保留領域を進めても既にreaderへ渡したviewを書き換えない", t => {
    const { filter } = fixture(t, false);
    const views = [], values = [];
    t.mock.method(filter._reader, "push", chunk => { views.push(chunk); values.push(Buffer.from(chunk)); });
    const pattern = Buffer.alloc(65539);
    for (let i = 0; i < pattern.length; ++i) { pattern[i] = [0x7F, 0x01, 0xFF, 0xFF][i % 4]; }
    filter.write(pattern);
    // 初期の所有領域を使い切るまで、偽候補をずらして追記する。
    for (let i = 0; i < 80; ++i) { filter.write(Buffer.alloc(1024, 0x12)); }
    filter.write(Buffer.concat([si, nil]));
    assert.ok(views.length > 0);
    assert.deepEqual(views, values);
    assert.equal(filter.closed, false);
});
