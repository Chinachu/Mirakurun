const { describe, it, before } = require("node:test");
const assert = require("assert");
const path = require("path");

// status.ts のタイマーでテストのプロセスが終了しなくなるため差し替える
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
require.cache[statusPath] = {
  id: statusPath,
  filename: statusPath,
  loaded: true,
  exports: { __esModule: true, default: { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0 } } }
};

const _ = require("../lib/Mirakurun/_").default;
const log = require("../lib/Mirakurun/log");
let TSMFTLV;

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04C11DB7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

let headerCC = 0;
// TSMF の多重フレームヘッダー (slotMap: 52 スロットの相対 TS 番号、tlvRelTs: TLV の相対 TS 番号)
function header({ slotMap, tlvRelTs = [1], numberOfCarriers = 1, carrierSequence = 1, numberOfFrames = 1, framePosition = 0, cc = headerCC++ }) {
  const p = Buffer.alloc(188, 0xFF);
  p[0] = 0x47;
  p[1] = 0x00;
  p[2] = 0x2F;
  p[3] = 0x10 | (cc & 0x0F);
  const payload = p.subarray(4);
  payload[0] = 0x1A;
  payload[1] = 0x86;
  payload[2] = 0x02; // frame_type: multi-carrier
  for (let i = 0; i < 52; i++) {
    const b = payload[69 + (i >> 1)];
    payload[69 + (i >> 1)] = (i & 1) === 0 ? (slotMap[i] << 4) | (b & 0x0F) : (b & 0xF0) | slotMap[i];
  }
  let streamTypeBits = 0x7FFF; // TS
  for (const n of tlvRelTs) {
    streamTypeBits &= ~(1 << (15 - n));
  }
  payload[121] = streamTypeBits >> 7;
  payload[122] = (streamTypeBits << 1) & 0xFF;
  payload[124] = numberOfCarriers;
  payload[125] = carrierSequence;
  payload[126] = (numberOfFrames << 4) | framePosition;
  payload.writeUInt32BE(crc32(payload.subarray(0, 180)), 180);
  return p;
}

function tlvPacket(n, length) {
  const p = Buffer.alloc(4 + length, n);
  p[0] = 0x7F;
  p[1] = 0x01;
  p.writeUInt16BE(length, 2);
  return p;
}

// TLV を PID 0x2D の TS パケットに分ける (TLV の先頭を含むパケットは PUSI と pointer_field を持つ)
function splitTLV(tlvPackets) {
  const data = Buffer.concat(tlvPackets);
  const starts = [];
  let pos = 0;
  for (const p of tlvPackets) {
    starts.push(pos);
    pos += p.length;
  }
  const packets = [];
  for (let offset = 0; offset < data.length;) {
    const p = Buffer.alloc(188, 0xFF);
    p[0] = 0x47;
    p[1] = 0x00;
    p[2] = 0x2D;
    const start = starts.find(s => s >= offset && s < offset + 184);
    if (start !== undefined) {
      p[1] = 0x40;
      p[3] = start - offset;
      data.copy(p, 4, offset, offset + 184);
      offset += 184;
    } else {
      data.copy(p, 3, offset, offset + 185);
      offset += 185;
    }
    packets.push(p);
  }
  return packets;
}

function tsPacket(pid) {
  const p = Buffer.alloc(188, 0);
  p[0] = 0x47;
  p[1] = pid >> 8;
  p[2] = pid & 0xFF;
  p[3] = 0x10;
  return p;
}

// slotMap に従って、相対 TS 1 のスロットに TLV のパケットを、ほかのスロットに TS のパケットを入れたフレームを作る
function frames(slotMap, tlvTsPackets, options = {}) {
  // 取り出しは continuity_counter がつながった 2 つ目のヘッダーから始めるため、最初に中身のないフレームを置く
  const out = [header({ slotMap, ...options }), ...slotMap.map(() => tsPacket(0x1FFF))];
  let i = 0;
  while (i < tlvTsPackets.length) {
    out.push(header({ slotMap, ...options }));
    for (const relTs of slotMap) {
      if (relTs === 1) {
        out.push(i < tlvTsPackets.length ? tlvTsPackets[i++] : tsPacket(0x1FFF));
      } else {
        out.push(tsPacket(0x100));
      }
    }
  }
  out.push(header({ slotMap, ...options })); // confirms the last frame before it is emitted
  return out;
}

const slotMap = Array.from({ length: 52 }, (_, i) => i % 2 === 0 ? 1 : 2);

describe("[tsmftlv.spec] TSMFTLV.ts", () => {
  before(() => {
    for (const level of ["info", "debug", "warn", "error"]) {
      log[level] = () => {};
    }
    TSMFTLV = require("../lib/Mirakurun/TSMFTLV").default;
  });

  it("assembles the TLV packets of the relative stream, regardless of the chunk boundaries", () => {
    const tlv = [tlvPacket(1, 100), tlvPacket(2, 500), tlvPacket(3, 10), tlvPacket(4, 3000), tlvPacket(5, 200)];
    const ts = Buffer.concat(frames(slotMap, splitTLV(tlv)));

    for (const size of [ts.length, 188, 1000, 7]) {
      const t = new TSMFTLV(1);
      const out = [];
      for (let pos = 0; pos < ts.length; pos += size) {
        out.push(t.push(ts.subarray(pos, pos + size)));
      }
      // 最後の TLV パケットは、次のパケットの先頭が来るまで完全かどうかを確かめられないが、長さで分かるため出力する
      assert.ok(Buffer.concat(out).equals(Buffer.concat(tlv)), `chunk size: ${size}`);
    }
  });

  it("drops the TLV packet broken by a lost slot, and starts again from the next one", () => {
    const tlv = [tlvPacket(1, 400), tlvPacket(2, 400), tlvPacket(3, 400), tlvPacket(4, 400)];
    const packets = splitTLV(tlv);
    // TLV パケット 2 の途中のパケット (先頭を含まないもの) を失う
    const lostIndex = packets.findIndex((p, i) => i > 2 && (p[1] & 0x40) === 0);
    const ts = frames(slotMap, packets);
    const lostPacket = packets[lostIndex];
    const t = new TSMFTLV(1);
    // 失ったパケットの位置には、別の PID のパケットが入る (受信の誤り)
    const out = t.push(Buffer.concat(ts.map(p => p === lostPacket ? tsPacket(0x123) : p)));

    const expected = Buffer.concat([tlv[0], tlv[2], tlv[3]]);
    // 壊れた TLV パケット 2 を捨て、次の PUSI が指すパケット 3 から再開する
    assert.ok(out.length < Buffer.concat(tlv).length);
    for (let pos = 0; pos < out.length;) {
      assert.strictEqual(out[pos], 0x7F);
      pos += 4 + out.readUInt16BE(pos + 2);
    }
    assert.ok(out.subarray(out.length - tlv[3].length).equals(tlv[3]));
    assert.ok(out.subarray(0, tlv[0].length).equals(tlv[0]));
    assert.deepStrictEqual(out, expected);
  });

  it("discards a short frame without leaking the other TLV relative stream, then recovers", () => {
    const map = Array.from({ length: 52 }, (_, i) => i < 26 ? 1 : 2);
    const selected = tlvPacket(1, 180);
    const foreign = tlvPacket(2, 180);
    const payload = [
      ...Array.from({ length: 26 }, () => splitTLV([selected])[0]),
      ...Array.from({ length: 26 }, () => splitTLV([foreign])[0])
    ];
    for (const loss of [0, 12, 25, 26, 51]) {
      const t = new TSMFTLV(1);
      const opts = { slotMap: map, tlvRelTs: [1, 2] };
      const damaged = payload.filter((_, i) => i !== loss);
      const input = Buffer.concat([
        header({ ...opts, cc: 0 }), ...map.map(() => tsPacket(0x1FFF)),
        header({ ...opts, cc: 1 }), ...damaged,
        header({ ...opts, cc: 2 })
      ]);
      assert.strictEqual(t.push(input).length, 0, `lost slot ${loss}`);
      assert.deepStrictEqual(t.push(Buffer.concat([...payload, header({ ...opts, cc: 3 })])),
        Buffer.concat(Array.from({ length: 26 }, () => selected)));
    }
  });

  it("drops the TLV packet when the frames between are lost", () => {
    // TLV パケット 2 は、失うフレームと、その次のフレーム (continuity_counter が飛ぶため使わない) より長い
    const tlv = [tlvPacket(1, 100), tlvPacket(2, 24000), tlvPacket(3, 100), tlvPacket(4, 100)];
    const ts = frames(slotMap, splitTLV(tlv));
    // 最初の中身のないフレームの後の、2 つ目のフレームを失う
    const frameSize = 53;
    const t = new TSMFTLV(1);
    const out = t.push(Buffer.concat([...ts.slice(0, frameSize * 2), ...ts.slice(frameSize * 3)]));

    // CC が飛んだヘッダーの直前の保留フレームも確定できないため破棄する。
    assert.deepStrictEqual(out, Buffer.concat([tlv[2], tlv[3]]));
  });

  it("does not output the frame of the channel tuned before, remaining right after tuning", () => {
    // 前のチャンネルのフレーム (CRC は正しい) の後に、continuity_counter が飛んで、このチャンネルのフレームが続く
    const stale = [header({ slotMap, cc: 9 }), ...splitTLV([tlvPacket(9, 3000)]).slice(0, 26)];
    const tlv = [tlvPacket(1, 100), tlvPacket(2, 200)];
    headerCC = 0;
    const out = new TSMFTLV(1).push(Buffer.concat([...stale, ...frames(slotMap, splitTLV(tlv))]));
    assert.ok(out.equals(Buffer.concat(tlv)));
  });

  it("outputs nothing for the relative stream of TS and for multiple carriers", () => {
    const ts = Buffer.concat(frames(slotMap, splitTLV([tlvPacket(1, 1000)]), { tlvRelTs: [2] }));
    assert.strictEqual(new TSMFTLV(1).push(ts).length, 0);

    const bonded = Buffer.concat(frames(slotMap, splitTLV([tlvPacket(1, 1000)]), { numberOfCarriers: 3 }));
    assert.strictEqual(new TSMFTLV(1).push(bonded).length, 0);
  });

  it("assembles TLV of a single carrier of frame_type 0x2, whatever carrier_sequence is", () => {
    const tlv = [tlvPacket(1, 1000), tlvPacket(2, 300)];
    // carrier_sequence が 0 から始まるか 1 から始まるかは規定されていない
    for (const options of [{ carrierSequence: 0 }, { numberOfCarriers: 0, carrierSequence: 0 }, { carrierSequence: 0xFF }]) {
      const ts = Buffer.concat(frames(slotMap, splitTLV(tlv), options));
      assert.ok(new TSMFTLV(1).push(ts).equals(Buffer.concat(tlv)), JSON.stringify(options));
    }
  });

  it("assembles the large TLV packets and the headers across the TS packets", () => {
    // TLV のヘッダー (4 バイト) が TS パケットの境界をまたぐように、TS パケットの残りより少し小さい TLV を挟む
    const tlv = [tlvPacket(1, 65000), tlvPacket(2, 178), tlvPacket(3, 30000), tlvPacket(4, 1), tlvPacket(5, 2)];
    const ts = Buffer.concat(frames(slotMap, splitTLV(tlv)));
    for (const size of [ts.length, 188, 61]) {
      const t = new TSMFTLV(1);
      const out = [];
      for (let pos = 0; pos < ts.length; pos += size) {
        out.push(t.push(ts.subarray(pos, pos + size)));
      }
      assert.ok(Buffer.concat(out).equals(Buffer.concat(tlv)), `chunk size: ${size}`);
    }
  });
});

describe("[tsmftlv.spec] StreamFormat.ts: detectTSMFStreamFormat()", () => {
  let detectTSMFStreamFormat;
  before(() => {
    ({ detectTSMFStreamFormat } = require("../lib/Mirakurun/StreamFormat"));
  });

  it("detects the relative stream by 2 headers in a row, not by the frame of the channel tuned before", () => {
    // 前のチャンネル (相対 TS 1 が TLV) のヘッダーが 1 つ残り、continuity_counter が飛んで TS のチャンネルのヘッダーが続く
    const stale = header({ slotMap, tlvRelTs: [1], cc: 3 });
    const frames = [0, 1, 2].map(cc => header({ slotMap, tlvRelTs: [], cc: 10 + cc }));
    assert.strictEqual(detectTSMFStreamFormat(Buffer.concat([stale, ...frames]), 1), "ts");
    assert.strictEqual(detectTSMFStreamFormat(Buffer.concat([header({ slotMap, cc: 0 }), header({ slotMap, cc: 1 })]), 1), "tlv");
    assert.strictEqual(detectTSMFStreamFormat(Buffer.concat([stale]), 1), null);
  });

  it("is used by the format detection of the service scan for the channels of TSMF", async () => {
    _.config = { server: {} };
    _.channel = { getStreams: () => [] };
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
    // 判別は 64KB を読み飛ばした後の 64KB で行う
    const tlv = Array.from({ length: 40 }, (_, i) => tlvPacket(i, 4000));
    for (const [tlvRelTs, expected] of [[[1], "tlv"], [[], "ts"]]) {
      const channel = new ChannelItem({ name: "CATV", type: "CS", channel: "C13", tsmfRelTs: 1 });
      const streamSetting = { channel };
      const data = Buffer.concat(frames(slotMap, splitTLV(tlv), { tlvRelTs }));
      const device = {
        config: { name: "t", types: ["CS"], tlvToTsDecoder: "mmt2ts" }, isRemote: false, users: [{ id: "scan", streamSetting }],
        async startStream(user, sink) {
          setImmediate(() => sink.write(data));
        }
      };
      const t = Object.create(Tuner.prototype);
      t._devices = [device];
      const probe = t._startFormatProbe({ id: "scan", priority: -1, streamSetting });
      assert.strictEqual((await probe.detected).format, expected);
    }
  });
});
