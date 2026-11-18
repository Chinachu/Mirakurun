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
const { describe, it, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("assert");

const log = require("../lib/Mirakurun/log");
let TSMFBonding;

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

function header({ numberOfCarriers, carrierSequence, numberOfFrames, framePosition, cc, otherSlots = 0 }) {
  const p = Buffer.alloc(188, 0xFF);
  p[0] = 0x47;
  p[1] = 0x00;
  p[2] = 0x2F;
  p[3] = 0x10 | (cc & 0x0F);
  const payload = p.subarray(4);
  payload[0] = 0x1A;
  payload[1] = 0x86;
  payload[2] = 0x02;
  // the slots are the relative stream 1 (TLV), the last `otherSlots` slots are the relative stream 2
  const relTs = slot => slot < 52 - otherSlots ? 1 : 2;
  for (let i = 0; i < 26; i++) {
    payload[69 + i] = (relTs(i * 2) << 4) | relTs(i * 2 + 1);
  }
  const streamTypeBits = 0x7FFF & ~(1 << 14);
  payload[121] = streamTypeBits >> 7;
  payload[122] = (streamTypeBits << 1) & 0xFF;
  payload[124] = numberOfCarriers;
  payload[125] = carrierSequence;
  payload[126] = (numberOfFrames << 4) | framePosition;
  payload.writeUInt32BE(crc32(payload.subarray(0, 180)), 180);
  return p;
}

// compressed IP packets (checked to find the alignment)
function tlvPackets(count) {
  const packets = [];
  for (let i = 0; i < count; i++) {
    const length = 100 + (i * 37) % 900;
    const p = Buffer.alloc(4 + length, i & 0xFF);
    p[0] = 0x7F;
    p[1] = 0x03;
    p.writeUInt16BE(length, 2);
    p[4 + 2] = 0x61;
    packets.push(p);
  }
  return packets;
}

function splitTLV(tlvPackets) {
  const data = Buffer.concat(tlvPackets);
  const starts = [];
  let pos = 0;
  for (const p of tlvPackets) {
    starts.push(pos);
    pos += p.length;
  }
  const packets = [];
  let nextStart = 0;
  for (let offset = 0; offset < data.length;) {
    const p = Buffer.alloc(188, 0xFF);
    p[0] = 0x47;
    p[1] = 0x00;
    p[2] = 0x2D;
    while (nextStart < starts.length && starts[nextStart] < offset) {
      nextStart++;
    }
    const start = starts[nextStart] < offset + 184 ? starts[nextStart] : undefined;
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

const nullPacket = Buffer.alloc(188, 0xFF);
nullPacket[0] = 0x47;
nullPacket[1] = 0x1F;
nullPacket[2] = 0xFF;

// a TS packet of the relative stream 2 (not of the group)
const otherPacket = Buffer.alloc(188, 0xAA);
otherPacket[0] = 0x47;
otherPacket[1] = 0x01;
otherPacket[2] = 0x00;
otherPacket[3] = 0x10;

// distributes the TS packets of TLV to the super frames of the carriers in the interleaved order
// (followed by the super frames of the null packets up to `minSuperframes`)
// `numberOfFrames`: the frames of a super frame (an array for each carrier), `otherSlots`: the slots of the relative stream 2 for each carrier
function carriers(packets, numberOfCarriers, numberOfFrames, minSuperframes = 0, firstSequence = 1, otherSlots = []) {
  const frames = Array.from({ length: numberOfCarriers }, (_, c) => Array.isArray(numberOfFrames) ? numberOfFrames[c] : numberOfFrames);
  const others = Array.from({ length: numberOfCarriers }, (_, c) => otherSlots[c] || 0);
  const maxFrames = Math.max(...frames);
  const perSuperframe = frames.reduce((sum, n, c) => sum + n * (52 - others[c]), 0);
  const superframes = Math.max(Math.ceil(packets.length / perSuperframe), minSuperframes);
  const streams = Array.from({ length: numberOfCarriers }, () => []);
  let next = 0;
  const cc = new Array(numberOfCarriers).fill(0);
  for (let sf = 0; sf < superframes; sf++) {
    const slots = frames.map(n => Array.from({ length: n }, () => new Array(52)));
    for (let sub = 0; sub < 53; sub++) {
      for (let position = 0; position < maxFrames; position++) {
        for (let c = 0; c < numberOfCarriers; c++) {
          const n = frames[c];
          if (position >= n) {
            continue;
          }
          const index = sub * n + position;
          const frame = Math.floor(index / 53);
          const slot = index % 53 - 1;
          if (slot < 0) {
            continue;
          }
          if (slot >= 52 - others[c]) {
            slots[c][frame][slot] = otherPacket;
            continue;
          }
          slots[c][frame][slot] = next < packets.length ? packets[next++] : nullPacket;
        }
      }
    }
    for (let c = 0; c < numberOfCarriers; c++) {
      const sfPackets = [];
      for (let frame = 0; frame < frames[c]; frame++) {
        sfPackets.push(header({ numberOfCarriers, carrierSequence: firstSequence + c, numberOfFrames: frames[c], framePosition: frame, cc: cc[c]++, otherSlots: others[c] }), ...slots[c][frame]);
      }
      streams[c].push(sfPackets);
    }
  }
  return streams;
}

// feeds the carriers alternately in chunks
function feed(bonding, streams, starts, chunkPackets = 20) {
  const inputs = streams.map((s, c) => Buffer.concat(s.slice(starts[c]).flat()));
  const out = [];
  let done = false;
  for (let pos = 0; done === false; pos += 188 * chunkPackets) {
    done = true;
    inputs.forEach((input, c) => {
      if (pos < input.length) {
        done = false;
        out.push(bonding.push(c, input.subarray(pos, pos + 188 * chunkPackets)));
      }
    });
  }
  return Buffer.concat(out);
}

// the TLV packets assembled are the original ones in the order (some may be dropped)
function assertTLV(out, tlv) {
  const all = Buffer.concat(tlv);
  assert.ok(out.length > all.length / 3, `assembled ${out.length} of ${all.length} bytes`);
  let k = 0;
  let pos = 0;
  let matched = 0;
  while (pos < out.length) {
    assert.strictEqual(out[pos], 0x7F);
    const packet = out.subarray(pos, pos + 4 + out.readUInt16BE(pos + 2));
    while (k < tlv.length && tlv[k].equals(packet) === false) {
      k++;
    }
    assert.ok(k < tlv.length, `a TLV packet at ${pos} is not in the original order`);
    k++;
    matched++;
    pos += packet.length;
  }
  assert.strictEqual(pos, out.length);
  return { matched, last: k };
}

describe("[tsmfbonding.spec] TSMFBonding.ts", () => {
  before(() => {
    for (const level of ["info", "debug", "warn", "error"]) {
      log[level] = () => {};
    }
    TSMFBonding = require("../lib/Mirakurun/TSMFBonding").default;
  });

  // ずれの探索を区切らない (結果がテストを実行する速さによらないように)
  beforeEach(() => TSMFBonding.alignSliceMs = Infinity);
  afterEach(() => TSMFBonding.alignSliceMs = 2);

  it("releases retained alignment samples when closed during a search", () => {
    TSMFBonding.alignSliceMs = 0;
    const streams = carriers(splitTLV(tlvPackets(2000)), 2, 1, 24);
    const bonding = new TSMFBonding(1, 2, () => assert.fail("the search must still be in progress"));
    try {
      for (let sf = 0; sf < 24 && !bonding._search; sf++) {
        for (let input = 0; input < 2; input++) {
          const output = bonding.push(input, Buffer.concat(streams[input][sf]));
          assert.equal(output.length, 0);
        }
      }
      assert.ok(bonding._search, "alignment search should start before closing");
      assert.ok(bonding._search.samples.every(sample => sample.length > 0));
      bonding.close();
      assert.ok(bonding._search === null, "closing releases the samples retained by the search");
      assert.equal(bonding.push(0, Buffer.concat(streams[0][0])).length, 0);
    } finally { bonding.close(); }
  });

  for (const slots of [8, 12]) {
    for (const seed of [1, 2, 3, 4, 5]) {
      it(`aligns sparse slots with large TLV without rejecting short-probe tails (slots=${slots}, seed=${seed})`, () => {
        let random = seed;
        const tlv = Array.from({ length: 1200 }, (_, index) => {
          random = (random * 1103515245 + 12345) & 0x7FFFFFFF;
          const length = 1200 + random % 301;
          const packet = Buffer.alloc(4 + length, index & 0xFF);
          packet[0] = 0x7F; packet[1] = 0x03;
          packet.writeUInt16BE(length, 2);
          packet[6] = 0x61;
          return packet;
        });
        const streams = carriers(splitTLV(tlv), 2, 1, 0, 1, [52 - slots, 52 - slots]);
        const errors = [], output = [];
        const bonding = new TSMFBonding(1, 2, reason => errors.push(reason));
        const starts = [0, 5];
        let firstOutputAt = -1;
        try {
          const count = Math.min(...streams.map((stream, carrier) => stream.length - starts[carrier]));
          for (let sf = 0; sf < count; ++sf) {
            for (let carrier = 0; carrier < 2; ++carrier) {
              const data = bonding.push(carrier, Buffer.concat(streams[carrier][starts[carrier] + sf]));
              if (data.length > 0 && firstOutputAt === -1) { firstOutputAt = sf; }
              output.push(data);
            }
          }
          assert.deepStrictEqual(errors, []);
          assert.ok(firstOutputAt >= 0 && firstOutputAt <= 30, `first output at superframe ${firstOutputAt}`);
          const { matched } = assertTLV(Buffer.concat(output), tlv);
          assert.ok(matched > tlv.length * 0.7, `assembled ${matched} of ${tlv.length} TLV packets`);
        } finally { bonding.close(); }
      });
    }
  }

  it("waits for the configured TLV stream after temporarily receiving non-TLV headers", t => {
    const warning = mock.method(log, "warn", () => {});
    t.after(() => warning.mock.restore());
    const tlv = tlvPackets(2400);
    const streams = carriers(splitTLV(tlv), 2, 1);
    for (const stream of streams) {
      for (const frame of stream.slice(0, 4)) {
        const packet = frame[0] = Buffer.from(frame[0]);
        const payload = packet.subarray(4);
        payload[121] = 0x7FFF >> 7;
        payload[122] = (0x7FFF << 1) & 0xFF;
        payload.writeUInt32BE(crc32(payload.subarray(0, 180)), 180);
      }
    }
    const errors = [];
    const bonding = new TSMFBonding(1, 2, reason => errors.push(reason));
    try {
      const out = feed(bonding, streams, [0, 0]);
      assert.deepStrictEqual(errors, []);
      assertTLV(out, tlv);
      const notices = warning.mock.calls.filter(call => call.arguments.some(value => typeof value === "string" && /相対ストリームはTLVではありません|the relative stream \d+ is not TLV/.test(value)));
      assert.strictEqual(notices.length, 1);
    } finally { bonding.close(); }
  });

  for (const [fault, numberOfFrames, frame] of [
    ["non-TLV", 1, 0], ["non-TLV", 4, 0],
    ["frame-position-middle", 4, 2], ["frame-position-start", 4, 0], ["frame-position-restart", 4, 3]
  ]) {
    for (const changedCarrier of [0, 1]) {
      it(`realigns after a valid-CRC ${fault} header on aligned carrier ${changedCarrier} (${numberOfFrames} frames)`, t => {
        const warnings = mock.method(log, "warn", () => {});
        t.after(() => warnings.mock.restore());
        const tlv = tlvPackets(30000);
        const streams = carriers(splitTLV(tlv), 2, numberOfFrames);
        const faultAt = numberOfFrames === 1 ? 150 : 60;
        const packet = streams[changedCarrier][faultAt][frame * 53] = Buffer.from(streams[changedCarrier][faultAt][frame * 53]);
        const payload = packet.subarray(4);
        if (fault === "non-TLV") {
          payload[121] = 0x7FFF >> 7;
          payload[122] = (0x7FFF << 1) & 0xFF;
        } else {
          const position = fault === "frame-position-middle" ? 3 : fault === "frame-position-start" ? 1 : 0;
          payload[126] = (numberOfFrames << 4) | position;
        }
        payload.writeUInt32BE(crc32(payload.subarray(0, 180)), 180);
        const errors = [], output = [];
        const bonding = new TSMFBonding(1, 2, reason => errors.push(reason));
        let lostAlignment = false, writtenBefore = 0, writtenAfter = 0;
        try {
          for (let sf = 0; sf < streams[0].length; ++sf) {
            if (sf === faultAt) {
              assert.ok(bonding._offsets, "fault must arrive after actual packets have aligned the carriers");
              assert.ok(writtenBefore > 0, "TLV must already be reaching the user");
            }
            for (let carrier = 0; carrier < 2; ++carrier) {
              const chunk = bonding.push(carrier, Buffer.concat(streams[carrier][sf]));
              output.push(chunk);
              if (sf < faultAt) { writtenBefore += chunk.length; }
              if (sf > faultAt) { writtenAfter += chunk.length; }
              if (sf === faultAt && carrier === changedCarrier) { lostAlignment = bonding._offsets === null; }
            }
          }
          assert.deepStrictEqual(errors, []);
          const { matched, last } = assertTLV(Buffer.concat(output), tlv);
          assert.ok(lostAlignment, "dropping a superframe must release the old carrier alignment");
          assert.ok(writtenAfter > 0, "the same configured TLV must resume after alignment is found again");
          assert.ok(last > tlv.length * 0.95, `last original packet: ${last} of ${tlv.length}`);
          assert.ok(matched > tlv.length * 0.7, `assembled ${matched} of ${tlv.length}`);
          assert.strictEqual(bonding._closed, false);
          assert.strictEqual(bonding._failures, 0, "known header loss must not be counted later as corrupted TLV");
          assert.ok(warnings.mock.calls.every(call => !call.arguments.some(value => typeof value === "string" && /結合したTLVの破損|broken TLV/.test(value))));
        } finally { bonding.close(); }
      });
    }
  }

  for (const failure of ["carrier-gap", "broken-tlv"]) {
    it(`counts ${failure} retries across real alignment searches`, t => {
      const warnings = mock.method(log, "warn", () => {});
      t.after(() => warnings.mock.restore());
      const errors = [];
      const bonding = new TSMFBonding(1, 2, reason => errors.push(reason));
      const streams = carriers(splitTLV(tlvPackets(14000)), 2, 1, 500);
      const positions = [0, 0];
      let written = 0;
      function push(c, corrupt = false) {
        assert.ok(positions[c] < streams[c].length, "fixture must contain the next superframe");
        const packets = streams[c][positions[c]++];
        const chunk = Buffer.concat(packets);
        if (corrupt) {
          let starts = 0;
          for (let offset = 0; offset < chunk.length; offset += 188) {
            if (chunk[offset + 2] === 0x2D && (chunk[offset + 1] & 0x40) !== 0 && ++starts % 2 === 0) {
              chunk[offset + 4 + chunk[offset + 3]] = 0;
            }
          }
        }
        written += bonding.push(c, chunk).length;
      }
      function align() {
        for (let count = 0; count < 100 && bonding._offsets === null && !bonding._closed; ++count) {
          push(0); push(1);
        }
        assert.ok(bonding._offsets, "real TSMF packets must complete the alignment search");
      }
      try {
        align();
        assert.ok(written > 0);
        for (let attempt = 0; attempt < 3; ++attempt) {
          if (failure === "carrier-gap") {
            for (let count = 0; count < 60; ++count) { push(0); }
            assert.equal(bonding._failures, attempt, "受信差60では再試行しません");
            assert.equal(bonding._closed, false);
            push(0);
          } else {
            for (let count = 0; count < 60 && bonding._offsets !== null && !bonding._closed; ++count) {
              push(0, true); push(1, true);
            }
          }
          assert.equal(bonding._failures, attempt + 1);
          assert.equal(bonding._closed, attempt === 2);
          if (attempt < 2) {
            while (positions[1] < positions[0]) { push(1); }
            align();
            assert.equal(bonding._failures, attempt + 1, "位置が合っただけでは失敗回数を戻しません");
          }
        }
        const reason = failure === "carrier-gap" ? "搬送波間の受信差が上限を超えました" : "結合したTLVの破損を検出しました";
        assert.deepEqual(errors, [reason]);
        assert.equal(warnings.mock.callCount(), 2);
        warnings.mock.calls.forEach((call, index) => {
          const text = require("node:util").format(...call.arguments.slice(0));
          assert.ok(text.includes(reason));
          assert.match(text, new RegExp(`\\(${index + 1}/3\\)`));
          assert.doesNotMatch(text, /受信が停止|stalled/);
        });
      } finally { bonding.close(); }
    });
  }

  it("resets alignment failures only after 30 superframes produce valid TLV", () => {
    const errors = [];
    const bonding = new TSMFBonding(1, 2, reason => errors.push(reason));
    const streams = carriers(splitTLV(tlvPackets(10000)), 2, 1, 350);
    const positions = [0, 0];
    let written = 0;
    function push(c) { written += bonding.push(c, Buffer.concat(streams[c][positions[c]++])).length; }
    function align() {
      for (let count = 0; count < 100 && bonding._offsets === null; ++count) { push(0); push(1); }
      assert.ok(bonding._offsets);
    }
    function gap() { for (let count = 0; count < 61; ++count) { push(0); } }
    try {
      align(); gap();
      assert.equal(bonding._failures, 1);
      while (positions[1] < positions[0]) { push(1); }
      align();
      assert.equal(bonding._failures, 1);
      const before = written;
      while (bonding._brokenSuperframes < 29) { push(0); push(1); }
      assert.equal(bonding._failures, 1, "29スーパーフレームでは失敗回数を保持します");
      push(0); push(1);
      assert.equal(bonding._failures, 0);
      assert.ok(written > before, "回復期間に実際のTLV出力が必要です");
      gap();
      assert.equal(bonding._failures, 1, "正常な回復後の障害は新たな1回として数えます");
      assert.equal(bonding._closed, false);
      assert.deepEqual(errors, []);
    } finally { bonding.close(); }
  });

  for (const frames of [1, 4]) {
    it(`aligns carriers while transport errors recur before alignment (${frames} frames)`, () => {
      const tlv = tlvPackets(frames === 1 ? 9000 : 30000);
      const streams = carriers(splitTLV(tlv), 2, frames);
      // 最初の判定に使う区間を含め、10スーパーフレームごとに搬送波1の1パケットだけ失う。
      for (let sf = 3; sf < streams[0].length; sf += 10) {
        const packet = Buffer.from(streams[0][sf][20]);
        packet[1] |= 0x80;
        streams[0][sf][20] = packet;
      }
      const errors = [];
      const bonding = new TSMFBonding(1, 2, reason => errors.push(reason));
      try {
        const out = feed(bonding, streams, [0, 7]);
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(bonding._closed, false);
        assert.strictEqual(bonding._failures, 0);
        const { last } = assertTLV(out, tlv);
        assert.ok(last > tlv.length * 0.95, `the last TLV packet assembled: ${last} of ${tlv.length}`);
      } finally { bonding.close(); }
    });
    it(`rejects a broken candidate even when later packets resynchronize (${frames} frames)`, () => {
      const streams = carriers(splitTLV(tlvPackets(6000)), 2, frames, 34);
      const bonding = new TSMFBonding(1, 2, () => assert.fail("sampling must not close the stream"));
      try {
        for (let c = 0; c < streams.length; c++) {
          bonding._inputs[c].push(Buffer.concat(streams[c].slice(0, 34).flat()));
          bonding._inputs[c].commit();
        }
        const samples = bonding._inputs.map(input => input.superframes);
        const packet = samples[0][5].frames[0].slots.find(item => (item[1] & 0x40) !== 0 && item[4 + item[3]] === 0x7F);
        assert.ok(packet);
        // 欠落のない連結が壊れた場合は、後続PUSIで再同期しても位置合わせ成功にしない。
        packet[4 + packet[3]] = 0;
        assert.strictEqual(bonding._checkAlignment(samples, [0, 0], 30), null);
      } finally { bonding.close(); }
    });
    for (const loss of ["TEI", "missing"]) {
      it(`accepts a correct alignment with ${loss} slots but rejects wrong skews (${frames} frames)`, () => {
        const streams = carriers(splitTLV(tlvPackets(6000)), 2, frames, 34);
        const bonding = new TSMFBonding(1, 2, () => assert.fail("sampling must not close the stream"));
        try {
          for (let c = 0; c < streams.length; c++) {
            bonding._inputs[c].push(Buffer.concat(streams[c].slice(0, 34).flat()));
            bonding._inputs[c].commit();
          }
          const samples = bonding._inputs.map(input => input.superframes);
          for (let sf = 3; sf < 30; sf += 10) {
            const slots = samples[0][sf].frames[0].slots;
            const packet = slots[19];
            assert.strictEqual(packet[2], 0x2D);
            slots[19] = loss === "missing" ? null : Buffer.from(packet);
            if (slots[19]) { slots[19][1] |= 0x80; }
          }
          assert.ok(bonding._checkAlignment(samples, [0, 0], 30) >= 0.9);
          assert.strictEqual(bonding._checkAlignment(samples, [0, 1], 30), null);
          assert.strictEqual(bonding._checkAlignment(samples, [1, 0], 30), null);
        } finally { bonding.close(); }
      });
    }
  }

  it("counts received superframes even when loss drops an older queue in the same push", () => {
    const errors = [];
    const bonding = new TSMFBonding(1, 2, reason => errors.push(reason));
    try {
      const stream = carriers([], 2, 1, 8)[0];
      bonding.push(0, Buffer.concat(stream.flat()));
      assert.ok(bonding._inputs[0].superframes.length > 1);
      const received = bonding._received;
      // 他の搬送波は1201スーパーフレーム進んだ直後。このpushで実際に届く1本を無視すると停止と誤判定する。
      bonding._received = received + 1201;
      bonding._lastReceived[1] = bonding._received;
      const resumed = [
        header({ numberOfCarriers: 2, carrierSequence: 1, numberOfFrames: 1, framePosition: 0, cc: 10 }),
        ...new Array(52).fill(nullPacket),
        header({ numberOfCarriers: 2, carrierSequence: 1, numberOfFrames: 1, framePosition: 0, cc: 11 }),
        ...new Array(52).fill(nullPacket)
      ];
      bonding.push(0, Buffer.concat(resumed));
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(bonding._closed, false);
      assert.strictEqual(bonding._received, received + 1202);
      assert.strictEqual(bonding._lastReceived[0], bonding._received);
      // 誤った停止判定を避けても、本当に止まった搬送波の検出は維持する。
      bonding._received += 1201;
      bonding._lastReceived[1] = bonding._received;
      bonding._assemble([]);
      assert.deepStrictEqual(errors, ["一部の搬送波を一定期間受信できませんでした"]);
    } finally { bonding.close(); }
  });

  it("assembles TLV of 3 carriers started at different super frames", () => {
    const tlv = tlvPackets(6000);
    const streams = carriers(splitTLV(tlv), 3, 2);
    const errors = [];
    // 搬送波ごとに、受信を始めたスーパーフレームが違う
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 2, 1]);

    assert.deepStrictEqual(errors, []);
    assertTLV(out, tlv);
  });

  it("assembles TLV of the carriers whose carrier_sequence starts from 0", () => {
    const tlv = tlvPackets(6000);
    const streams = carriers(splitTLV(tlv), 3, 2, 0, 0);
    const errors = [];
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 2, 1]);

    assert.deepStrictEqual(errors, []);
    assertTLV(out, tlv);
  });

  // 8K の例: 256QAM (4 フレーム) の 2 搬送波と、2K と共有する 64QAM (3 フレーム) の 1 搬送波
  it("assembles TLV of the carriers of 256QAM and 64QAM, sharing a carrier with another stream", () => {
    const tlv = tlvPackets(6000);
    const streams = carriers(splitTLV(tlv), 3, [4, 4, 3], 0, 1, [0, 0, 20]);
    const errors = [];
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 2, 1]);

    assert.deepStrictEqual(errors, []);
    assertTLV(out, tlv);
  });

  // 拡張 TSMF の frame_type 0x1: 複数 TS 伝送方式の信号 (相対 TS 2) と、複数搬送波伝送方式の信号の一部 (相対 TS 1 の TLV)
  it("assembles TLV of the carriers of frame_type 0x1, sharing a carrier with the stream of multi-TS", () => {
    const tlv = tlvPackets(6000);
    const streams = carriers(splitTLV(tlv), 3, [4, 4, 3], 0, 1, [0, 0, 20]);
    for (const p of streams.flat(2)) {
      if (p[2] === 0x2F && p[1] === 0x00) {
        p[6] = 0x01;
        p.writeUInt32BE(crc32(p.subarray(4, 184)), 184);
      }
    }
    const errors = [];
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 2, 1]);

    assert.deepStrictEqual(errors, []);
    assertTLV(out, tlv);
  });

  it("aligns the carriers of 256QAM and 64QAM with a skew", () => {
    const tlv = tlvPackets(28000);
    const streams = carriers(splitTLV(tlv), 3, [4, 4, 3], 0, 1, [0, 0, 20]);
    const errors = [];
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 43, 17]);

    assert.deepStrictEqual(errors, []);
    const { matched } = assertTLV(out, tlv);
    assert.ok(matched > tlv.length / 3);
  });

  it("reports an error when the channels of the group receive the same carrier", () => {
    const streams = carriers(splitTLV(tlvPackets(6000)), 3, 2);
    const errors = [];
    feed(new TSMFBonding(1, 3, reason => errors.push(reason)), [streams[0], streams[1], streams[1]], [0, 0, 0]);

    assert.deepStrictEqual(errors, ["複数のチャンネルで同じ搬送波を受信しました (carrier_sequence: 1, 2, 2)"]);
  });

  it("aligns the carriers again after a super frame of a carrier is lost", () => {
    const tlv = tlvPackets(9000);
    const streams = carriers(splitTLV(tlv), 3, 2);
    // 搬送波 2 のスーパーフレーム 20 を失う
    streams[1].splice(20, 1);
    const errors = [];
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 0, 0]);

    assert.deepStrictEqual(errors, []);
    const { matched, last } = assertTLV(out, tlv);
    // 失った後も組み立て直して、最後の近くまで出力する
    assert.ok(last > tlv.length * 0.9, `the last TLV packet assembled: ${last} of ${tlv.length}`);
    assert.ok(matched > tlv.length * 0.7, `assembled ${matched} of ${tlv.length} TLV packets`);
  });

  // ヘッダーのカウンターが一周する数 (16) のフレームを失うと、損失として検出できない。組み立てた TLV が壊れ続けることで検出し、組み立て直す
  it("aligns the carriers again when the TLV assembled is broken by the super frames lost without being detected", () => {
    const tlv = tlvPackets(30000);
    const streams = carriers(splitTLV(tlv), 2, 1);
    streams[1].splice(300, 16);
    const errors = [];
    const out = feed(new TSMFBonding(1, 2, reason => errors.push(reason)), streams, [0, 0]);

    assert.deepStrictEqual(errors, []);
    // the TLV packets differ by the length and the byte filled
    const key = packet => packet.length * 256 + packet[5];
    const index = new Map(tlv.map((packet, i) => [key(packet), i]));
    let broken = 0;
    let matched = 0;
    let last = -1;
    for (let pos = 0; pos + 4 <= out.length;) {
      const packet = out.subarray(pos, pos + 4 + out.readUInt16BE(pos + 2));
      const i = index.get(key(packet));
      if (i !== undefined && i > last && tlv[i].equals(packet)) {
        matched++;
        last = i;
      } else {
        broken++;
      }
      pos += packet.length;
    }
    // 壊れた TLV は検出するまで (30 スーパーフレーム) の分だけで、その後は最後の近くまで出力する
    assert.ok(broken > 0 && broken < 1500, `${broken} TLV packets are broken`);
    assert.ok(last > tlv.length * 0.99, `the last TLV packet assembled: ${last} of ${tlv.length}`);
    assert.ok(matched > tlv.length * 0.9, `assembled ${matched} of ${tlv.length} TLV packets`);
  });

  // 送出された TLV が壊れていても (長さの誤り)、ずれてはいないので組み立て直さない (組み立て直すと、壊れた TLV でずれを見つけられずに閉じる)
  for (const [numberOfCarriers, numberOfFrames] of [[2, 1], [3, 4]]) it(`keeps the alignment when the TLV is broken as sent (${numberOfCarriers} carriers of ${numberOfFrames} frames)`, () => {
    const tlv = tlvPackets(60000);
    // 1 of 20 TLV packets (after the carriers are aligned: finding the alignment needs the valid TLV)
    const sent = tlv.map((packet, i) => {
      if (i < 20000 || i % 20 !== 10) {
        return packet;
      }
      const broken = Buffer.from(packet);
      broken.writeUInt16BE(broken.length - 4 + 7, 2);
      return broken;
    });
    const streams = carriers(splitTLV(sent), numberOfCarriers, numberOfFrames);
    const errors = [];
    const warn = mock.method(log, "warn", () => {});
    const out = feed(new TSMFBonding(1, numberOfCarriers, reason => errors.push(reason)), streams, new Array(numberOfCarriers).fill(0));
    const warned = warn.mock.calls.map(call => call.arguments[1]);
    warn.mock.restore();

    assert.deepStrictEqual([errors, warned], [[], []]);
    assert.ok(out.length > Buffer.concat(tlv).length * 0.8, `assembled ${out.length} of ${Buffer.concat(tlv).length} bytes`);
  });

  // パケットを失っても (エラーのあるパケット)、ずれてはいないので組み立て直さない
  it("keeps the alignment when the packets of a carrier are lost", () => {
    const tlv = tlvPackets(30000);
    const streams = carriers(splitTLV(tlv), 2, 1);
    // 1 of 5 slots of the carrier 1 with transport_error_indicator (after the carriers are aligned)
    for (let sf = 100; sf < streams[0].length; sf++) {
      for (let slot = 1 + sf % 5; slot < streams[0][sf].length; slot += 5) {
        const packet = Buffer.from(streams[0][sf][slot]);
        packet[1] |= 0x80;
        streams[0][sf][slot] = packet;
      }
    }
    const errors = [];
    const warn = mock.method(log, "warn", () => {});
    const out = feed(new TSMFBonding(1, 2, reason => errors.push(reason)), streams, [0, 0]);
    const warned = warn.mock.calls.map(call => call.arguments[1]);
    warn.mock.restore();

    assert.deepStrictEqual([errors, warned], [[], []]);
    assertTLV(out, tlv);
  });

  it("keeps the alignment after a broken header (CRC) of a carrier, losing the frame after it", () => {
    const tlv = tlvPackets(9000);
    const streams = carriers(splitTLV(tlv), 3, 2);
    const errors = [];
    // without the broken header (the TLV packets before the alignment are not assembled)
    const { matched: all } = assertTLV(feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 0, 0]), tlv);
    // 搬送波 2 のスーパーフレーム 30 の 2 番目のフレームのヘッダーが壊れる
    const broken = Buffer.from(streams[1][30][53]);
    broken[100] ^= 0xFF;
    streams[1][30][53] = broken;
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 0, 0]);

    assert.deepStrictEqual(errors, []);
    const { matched } = assertTLV(out, tlv);
    // 並べ直さず、壊れたヘッダーの後のフレームのスロットにかかる TLV パケットだけを失う
    // (そのスロットはスーパーフレーム全体に散らばる: 1 スーパーフレームは 3 x 2 x 52 スロット、TLV パケットは平均 554 バイト)
    const perSuperframe = Math.ceil(3 * 2 * 52 * 184 / 554);
    assert.ok(matched < all && matched > all - perSuperframe, `assembled ${matched} of ${all} TLV packets`);
  });

  it("aligns the carriers after a broken header (CRC) of a carrier not aligned yet", () => {
    const tlv = tlvPackets(9000);
    const streams = carriers(splitTLV(tlv), 3, 2);
    // 位置合わせの前 (スーパーフレーム 3) に、搬送波 2 のヘッダーが壊れる
    const broken = Buffer.from(streams[1][3][53]);
    broken[100] ^= 0xFF;
    streams[1][3][53] = broken;
    const errors = [];
    const bonding = new TSMFBonding(1, 3, reason => errors.push(reason));
    const out = feed(bonding, streams, [0, 0, 0]);

    assert.deepStrictEqual(errors, []);
    // the frame lost is not in the super frames to find the alignment (it would fail the check)
    assert.strictEqual(bonding._failures, 0);
    const { last } = assertTLV(out, tlv);
    assert.ok(last > tlv.length * 0.9, `the last TLV packet assembled: ${last} of ${tlv.length}`);
  });

  it("aligns the carriers again after a loss right after a broken header (CRC) of another carrier", () => {
    const tlv = tlvPackets(9000);
    const streams = carriers(splitTLV(tlv), 3, 2);
    // 搬送波 2 のスーパーフレーム 30 の最初のヘッダーが壊れ、次のフレームが来る前に搬送波 1 のパケットを失う
    // (搬送波 1 は 2 スーパーフレーム遅れて届く)
    const broken = Buffer.from(streams[1][30][0]);
    broken[100] ^= 0xFF;
    streams[1][30][0] = broken;
    const lost = Buffer.from(streams[0][28][25]);
    lost[0] = 0x00;
    streams[0][28][25] = lost;
    const lag = Buffer.concat(new Array(53 * 2 * 2).fill(nullPacket));
    const inputs = streams.map((s, c) => Buffer.concat([c === 0 ? lag : Buffer.alloc(0), ...s.flat()]));
    const errors = [];
    const bonding = new TSMFBonding(1, 3, reason => errors.push(reason));
    const out = [];
    for (let pos = 0, done = false; done === false; pos += 188 * 20) {
      done = true;
      inputs.forEach((input, c) => {
        if (pos < input.length) {
          done = false;
          out.push(bonding.push(c, input.subarray(pos, pos + 188 * 20)));
        }
      });
    }

    assert.deepStrictEqual(errors, []);
    // the frame lost is not in the super frames to find the alignment again
    assert.strictEqual(bonding._failures, 0);
    const { last } = assertTLV(Buffer.concat(out), tlv);
    assert.ok(last > tlv.length * 0.9, `the last TLV packet assembled: ${last} of ${tlv.length}`);
  });

  it("does not align by the super frames before a loss of a carrier not aligned yet", () => {
    const tlv = tlvPackets(15000);
    const streams = carriers(splitTLV(tlv), 3, 1);
    // 搬送波 2 のスーパーフレーム 45 を失う (ずれを判定する前に、他の搬送波より先に受信する)
    streams[1].splice(45, 1);
    const errors = [];
    const bonding = new TSMFBonding(1, 3, reason => errors.push(reason));
    const out = [bonding.push(1, Buffer.concat(streams[1].slice(0, 50).flat()))];
    out.push(feed(bonding, [streams[0], streams[1].slice(50), streams[2]], [0, 0, 0]));

    assert.deepStrictEqual(errors, []);
    // 失う前のスーパーフレームでずれを判定すると、失った後の TLV が壊れる
    const { matched } = assertTLV(Buffer.concat(out), tlv);
    assert.ok(matched > tlv.length / 2, `assembled ${matched} of ${tlv.length} TLV packets`);
  });

  const lossCases = {
    // 200 スーパーフレームごとに 1 つ失う
    periodic: sf => sf % 200 === 199,
    none: () => false,
    // 時間がかかる探索 (遅い CPU) の途中で 1 回だけ失う
    once: sf => sf === 3700,
    // 1 つのパケットの同期バイトが壊れる (同期し直すまでの欠落は 1 回と数える)
    sync: sf => sf === 3700 ? "sync" : false
  };
  for (const [losses, lost] of Object.entries(lossCases)) {
    it(losses === "periodic" ? "reports an error when the losses keep interrupting finding the alignment" : `does not close the stream finding the alignment for long (a slow CPU), losses: ${losses}`, () => {
      // ずれの候補を 1 回に 1 つだけ調べる (他の搬送波のずれが見込みから外れ、探索に時間がかかる)
      TSMFBonding.alignSliceMs = 0;
      // 約 30 秒の後に失うまで受信する
      const streams = carriers(splitTLV(tlvPackets(3000)), 3, 1, 4200);
      const starts = [0, 20, 0];
      const errors = [];
      const bonding = new TSMFBonding(1, 3, reason => errors.push(reason));
      for (let sf = 0; sf + 20 < streams[0].length && errors.length === 0; sf++) {
        for (let c = 0; c < 3; c++) {
          const loss = c === 2 && lost(sf);
          if (loss === true) {
            continue;
          }
          const chunk = Buffer.concat(streams[c][starts[c] + sf]);
          if (loss === "sync") {
            chunk[188 * 10] = 0x00;
          }
          bonding.push(c, chunk);
        }
      }

      assert.deepStrictEqual(errors, losses === "periodic" ? ["搬送波の位置を確定できませんでした"] : []);
    });
  }

  it("reports an error when a carrier has stalled", () => {
    const tlv = tlvPackets(40000);
    // 他の搬送波は、止まった後も約 10 秒分を受信する
    const streams = carriers(splitTLV(tlv), 3, 2, 2600);
    // 搬送波 3 が途中で止まる
    streams[2].splice(10);
    const errors = [];
    feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 0, 0]);

    assert.deepStrictEqual(errors, ["一部の搬送波を一定期間受信できませんでした"]);
  });

  it("reports an error when a carrier never delivers its first header", () => {
    const streams = carriers(splitTLV(tlvPackets(40000)), 3, 2, 2600);
    streams[2] = [];
    const errors = [];
    const bonding = new TSMFBonding(1, 3, reason => errors.push(reason));
    const out = feed(bonding, streams, [0, 0, 0]);
    assert.deepStrictEqual(errors, ["一部の搬送波を一定期間受信できませんでした"]);
    assert.strictEqual(out.length, 0);
    assert.strictEqual(bonding.push(0, Buffer.alloc(188)).length, 0);
  });

  it("assembles TLV when the tuners of the other carriers start 3 seconds later", () => {
    const tlv = tlvPackets(40000);
    const streams = carriers(splitTLV(tlv), 3, 1);
    // 搬送波 1 だけを約 3 秒分 (370 スーパーフレーム) 受信した後に、他の搬送波の受信が始まる
    const lead = 370;
    const errors = [];
    const bonding = new TSMFBonding(1, 3, reason => errors.push(reason));
    const out = [];
    for (let sf = 0; sf < streams[0].length; sf++) {
      for (let c = 0; c < 3; c++) {
        if (c === 0 || sf >= lead) {
          out.push(bonding.push(c, Buffer.concat(streams[c][sf])));
        }
      }
    }
    assert.deepStrictEqual(errors, []);
    const { matched } = assertTLV(Buffer.concat(out), tlv);
    // 他の搬送波の受信が始まった後の TLV を出力する
    assert.ok(matched > tlv.length * (1 - lead / streams[0].length) * 0.9, `assembled ${matched} of ${tlv.length} TLV packets`);
  });

  it("aligns carriers with a 43-superframe skew without losing or reordering TLV packets", () => {
    const tlv = tlvPackets(28000);
    const streams = carriers(splitTLV(tlv), 3, 4);
    const errors = [];
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [1, 43, 0]);
    assert.deepStrictEqual(errors, []);
    const { matched } = assertTLV(out, tlv);
    assert.ok(matched > tlv.length / 3);
  });

  it("finds the skews of 4 carriers in slices, not blocking the other streams", t => {
    // 実処理を呼びつつ検査1回を0.0001msに進め、OSの停止やGCを探索予算の判定へ混ぜない。
    let checks = 0;
    const clock = Object.getOwnPropertyDescriptor(performance, "now");
    const checkAlignment = TSMFBonding.prototype._checkAlignment;
    // mockの全呼出履歴に巨大なsample配列を残さず、件数だけを観測する。
    Object.defineProperty(performance, "now", { configurable: true, value: () => checks / 10000 });
    TSMFBonding.prototype._checkAlignment = function (...args) {
      ++checks;
      return checkAlignment.apply(this, args);
    };
    t.after(() => {
      TSMFBonding.prototype._checkAlignment = checkAlignment;
      if (clock) { Object.defineProperty(performance, "now", clock); } else { delete performance.now; }
    });
    TSMFBonding.alignSliceMs = 10;
    const tlv = tlvPackets(60000);
    const streams = carriers(splitTLV(tlv), 4, 1);
    const errors = [];
    const bonding = new TSMFBonding(1, 4, reason => errors.push(reason));
    const starts = [0, 50, 30, 10];
    const out = [];
    let maxChecks = 0;
    let workingPushes = 0;
    for (let sf = 0; sf < streams[0].length - 50; sf++) {
      for (let c = 0; c < 4; c++) {
        const before = checks;
        out.push(bonding.push(c, Buffer.concat(streams[c][starts[c] + sf])));
        const count = checks - before;
        maxChecks = Math.max(maxChecks, count);
        if (count > 0) { ++workingPushes; }
      }
    }
    assert.deepStrictEqual(errors, []);
    // 1候補のprobeと本検査は分割しないため、10msの予算を最大2検査分だけ超えられる。
    assert.ok(maxChecks <= 100002, `a push performed ${maxChecks} alignment checks`);
    assert.ok(workingPushes > 1, "the real alignment search must return between bounded slices");
    const { matched } = assertTLV(Buffer.concat(out), tlv);
    assert.ok(matched > tlv.length / 3, `assembled ${matched} of ${tlv.length} TLV packets`);
  });

  it("keeps samples when one carrier is delivered in a large burst before the others", () => {
    const tlv = tlvPackets(12000);
    const inputs = carriers(splitTLV(tlv), 3, 4).map(s => Buffer.concat(s.flat()));
    const positions = [0, 0, 0];
    const errors = [];
    const bonding = new TSMFBonding(1, 3, reason => errors.push(reason));
    const output = [];
    const push = (carrier, bytes) => {
      const end = Math.min(inputs[carrier].length, positions[carrier] + bytes);
      output.push(bonding.push(carrier, inputs[carrier].subarray(positions[carrier], end)));
      positions[carrier] = end;
    };
    const superframeBytes = 188 * 53 * 4;
    push(0, superframeBytes * 40);
    push(1, superframeBytes * 10);
    push(2, superframeBytes * 10);
    while (positions.some((pos, i) => pos < inputs[i].length)) {
      for (let i = 0; i < inputs.length; i++) {
        if (positions[i] < inputs[i].length) {
          push(i, 188 * 20);
        }
      }
    }
    assert.deepStrictEqual(errors, []);
    const { matched } = assertTLV(Buffer.concat(output), tlv);
    assert.ok(matched > tlv.length * 0.9, `assembled ${matched} of ${tlv.length} TLV packets`);
  });

});
