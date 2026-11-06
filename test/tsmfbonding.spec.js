const { describe, it, before } = require("node:test");
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

function header({ numberOfCarriers, carrierSequence, numberOfFrames, framePosition, cc }) {
  const p = Buffer.alloc(188, 0xFF);
  p[0] = 0x47;
  p[1] = 0x00;
  p[2] = 0x2F;
  p[3] = 0x10 | (cc & 0x0F);
  const payload = p.subarray(4);
  payload[0] = 0x1A;
  payload[1] = 0x86;
  payload[2] = 0x02;
  // all the slots are the relative stream 1 (TLV)
  payload.fill(0x11, 69, 69 + 26);
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

// distributes the TS packets of TLV to the super frames of the carriers in the interleaved order
function carriers(packets, numberOfCarriers, numberOfFrames) {
  const perSuperframe = numberOfCarriers * numberOfFrames * 52;
  const superframes = Math.ceil(packets.length / perSuperframe);
  const streams = Array.from({ length: numberOfCarriers }, () => []);
  let next = 0;
  const cc = new Array(numberOfCarriers).fill(0);
  for (let sf = 0; sf < superframes; sf++) {
    const slots = Array.from({ length: numberOfCarriers }, () => Array.from({ length: numberOfFrames }, () => new Array(52)));
    for (let sub = 0; sub < 53; sub++) {
      for (let position = 0; position < numberOfFrames; position++) {
        for (let c = 0; c < numberOfCarriers; c++) {
          const index = sub * numberOfFrames + position;
          const frame = Math.floor(index / 53);
          const slot = index % 53 - 1;
          if (slot < 0) {
            continue;
          }
          const p = Buffer.alloc(188, 0xFF);
          p[0] = 0x47;
          p[1] = 0x1F;
          p[2] = 0xFF;
          slots[c][frame][slot] = next < packets.length ? packets[next++] : p;
        }
      }
    }
    for (let c = 0; c < numberOfCarriers; c++) {
      const sfPackets = [];
      for (let frame = 0; frame < numberOfFrames; frame++) {
        sfPackets.push(header({ numberOfCarriers, carrierSequence: c + 1, numberOfFrames, framePosition: frame, cc: cc[c]++ }), ...slots[c][frame]);
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

  it("assembles TLV of 3 carriers started at different super frames", () => {
    const tlv = tlvPackets(6000);
    const streams = carriers(splitTLV(tlv), 3, 2);
    const errors = [];
    // 搬送波ごとに、受信を始めたスーパーフレームが違う
    const out = feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 2, 1]);

    assert.deepStrictEqual(errors, []);
    assertTLV(out, tlv);
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

  it("reports an error when a carrier has stalled", () => {
    const tlv = tlvPackets(40000);
    const streams = carriers(splitTLV(tlv), 3, 2);
    // 搬送波 3 が途中で止まる
    streams[2].splice(10);
    const errors = [];
    feed(new TSMFBonding(1, 3, reason => errors.push(reason)), streams, [0, 0, 0]);

    assert.deepStrictEqual(errors, ["a carrier has stalled"]);
  });

  it("reports an error when a carrier never delivers its first header", () => {
    const streams = carriers(splitTLV(tlvPackets(40000)), 3, 2);
    streams[2] = [];
    const errors = [];
    const bonding = new TSMFBonding(1, 3, reason => errors.push(reason));
    const out = feed(bonding, streams, [0, 0, 0]);
    assert.deepStrictEqual(errors, ["a carrier has stalled"]);
    assert.strictEqual(out.length, 0);
    assert.strictEqual(bonding.push(0, Buffer.alloc(188)).length, 0);
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
