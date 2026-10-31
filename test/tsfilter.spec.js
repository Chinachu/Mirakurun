const { describe, it, before } = require("node:test");
const assert = require("assert");
const path = require("path");
const { Writable } = require("stream");

// status.ts のタイマーでテストのプロセスが終了しなくなるため差し替える
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
require.cache[statusPath] = {
  id: statusPath,
  filename: statusPath,
  loaded: true,
  exports: { __esModule: true, default: { epg: {}, streamCount: { tsFilter: 0, decoder: 0 } } }
};

const _ = require("../lib/Mirakurun/_").default;
const log = require("../lib/Mirakurun/log");

let TSFilter;

function packet(pid, n, tei = false) {
  const p = Buffer.alloc(188, n & 0xFF);
  p[0] = 0x47;
  p[1] = (tei ? 0x80 : 0) | (pid >> 8);
  p[2] = pid & 0xFF;
  p[3] = 0x10 | (n & 0x0F);
  return p;
}

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

function sectionPacket(pid, n, body) {
  const p = packet(pid, n);
  p.fill(0xFF, 4);
  p[1] |= 0x40; // payload_unit_start_indicator
  p[4] = 0; // pointer_field
  Buffer.from(body).copy(p, 5);
  p.writeUInt32BE(crc32(body), 5 + body.length);
  return p;
}

// serviceId=1024 (PMT PID=0x1F0, ES PID=0x100, 0x110), serviceId=1025 (PMT PID=0x1F1, ES PID=0x200)
const patPacket = n => sectionPacket(0, n, [0x00, 0xB0, 17, 0x7F, 0xE1, 0xC1, 0, 0, 0x04, 0x00, 0xE1, 0xF0, 0x04, 0x01, 0xE1, 0xF1]);
const pmt1024Packet = n => sectionPacket(0x1F0, n, [0x02, 0xB0, 23, 0x04, 0x00, 0xC1, 0, 0, 0xE1, 0x00, 0xF0, 0x00, 0x02, 0xE1, 0x00, 0xF0, 0x00, 0x0F, 0xE1, 0x10, 0xF0, 0x00]);
const pmt1025Packet = n => sectionPacket(0x1F1, n, [0x02, 0xB0, 18, 0x04, 0x01, 0xC1, 0, 0, 0xE2, 0x00, 0xF0, 0x00, 0x02, 0xE2, 0x00, 0xF0, 0x00]);

const tick = () => new Promise(resolve => setImmediate(resolve));

function collector(highWaterMark) {
  const chunks = [];
  const output = new Writable({
    highWaterMark,
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  output.result = () => Buffer.concat(chunks);
  return output;
}

function writeInChunks(filter, ts, sizes) {
  let pos = 0;
  for (let i = 0; pos < ts.length; i++) {
    const size = sizes[i % sizes.length];
    filter.write(ts.subarray(pos, pos + size));
    pos += size;
  }
}

describe("[tsfilter.spec] TSFilter.ts: write()", () => {
  before(() => {
    _.config = { server: { maxBufferBytesBeforeReady: 188 * 5 } };
    _.program = { get: () => null };
    for (const level of ["info", "debug", "warn", "error"]) {
      log[level] = () => {};
    }
    TSFilter = require("../lib/Mirakurun/TSFilter").default;
  });

  it("passes all packets except NULL and errored packets, regardless of chunk boundaries", () => {
    const packets = [];
    const expected = [];
    for (let i = 0; i < 500; i++) {
      const pid = [0x100, 0x110, 0x1FFF, 0x100, 0x200][i % 5];
      const tei = i % 17 === 0;
      const p = packet(pid, i, tei);
      packets.push(p);
      if (pid !== 0x1FFF && !tei) {
        expected.push(p);
      }
    }
    // 同期バイトの検証で読み飛ばされる不正なバイト列
    packets.splice(100, 0, Buffer.from([0x00, 0x01, 0x02]));
    const ts = Buffer.concat(packets);

    for (const sizes of [[ts.length], [188], [1, 187, 189, 5000], [100, 88, 7, 3000]]) {
      const output = collector(1024 * 1024);
      const filter = new TSFilter({ output });

      writeInChunks(filter, ts, sizes);

      assert.ok(output.result().equals(Buffer.concat(expected)), `chunk sizes: ${sizes}`);
      assert.strictEqual(filter.streamInfo[0x100].packet + filter.streamInfo[0x110].packet + filter.streamInfo[0x200].packet, expected.length);
      filter.close();
    }
  });

  it("provides only the packets of the service with the PAT rewritten, regardless of chunk boundaries", async () => {
    const packets = [];
    for (let i = 0; i < 400; i++) {
      const pid = [0, 0x1F0, 0x1F1, 0x100, 0x110, 0x200, 0x1FFF, 0x12, 0x100, 0x14, 0x200, 0x300][i % 12];
      packets.push(pid === 0 ? patPacket(i) : pid === 0x1F0 ? pmt1024Packet(i) : pid === 0x1F1 ? pmt1025Packet(i) : packet(pid, i));
    }
    const ts = Buffer.concat(packets);

    for (const sizes of [[ts.length], [188], [1, 187, 189, 5000], [100, 88, 7, 3000]]) {
      const output = collector(1024 * 1024);
      const filter = new TSFilter({ output, serviceId: 1024 });

      // PAT と PMT を解析させて準備完了にする (準備中のパケットは出力されない)
      filter.write(Buffer.concat([patPacket(0), pmt1024Packet(0)]));
      await tick();
      filter.write(pmt1024Packet(1));
      await tick();
      assert.strictEqual(filter._ready, true);

      writeInChunks(filter, ts, sizes);

      const expected = [];
      for (const p of packets) {
        const pid = p.readUInt16BE(1) & 0x1FFF;
        if (pid === 0) {
          expected.push(Buffer.concat([p.subarray(0, 5), filter._patsec]));
        } else if ([0x1F0, 0x100, 0x110, 0x12, 0x14].includes(pid)) {
          expected.push(p);
        }
      }
      assert.ok(output.result().equals(Buffer.concat(expected)), `chunk sizes: ${sizes}`);
      // 書き換え後の PAT には serviceId=1024 だけが含まれる
      assert.deepStrictEqual([...filter._patsec.subarray(12, 16)], [0x04, 0x00, 0xE1, 0xF0]);
      filter.close();
    }
  });

  it("keeps only the latest packets up to maxBufferBytesBeforeReady while waiting", () => {
    // 0x11 (SDT) は出力対象、0x999 は対象外
    const packets = [];
    for (let i = 0; i < 40; i++) {
      packets.push(packet(i % 3 === 2 ? 0x999 : 0x11, i));
    }
    const ts = Buffer.concat(packets);
    const provided = packets.filter((p, i) => i % 3 !== 2);

    for (const sizes of [[ts.length], [188 * 3, 188, 188 * 7], [100, 88, 947, 181]]) {
      const filter = new TSFilter({ output: collector(1024 * 1024), serviceId: 1, eventId: 1 });

      writeInChunks(filter, ts, sizes);

      assert.ok(Buffer.concat(filter._buffer).equals(Buffer.concat(provided.slice(-5))), `chunk sizes: ${sizes}`);
      filter.close();
    }
  });
});
