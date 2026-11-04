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
      // 保持しているパケットは入力のチャンクを参照しない (出力しないパケットの分までメモリを抱え込まない)
      const overlaps = b => b.buffer === ts.buffer && b.byteOffset < ts.byteOffset + ts.length && ts.byteOffset < b.byteOffset + b.length;
      assert.ok(!filter._buffer.some(overlaps), `chunk sizes: ${sizes}`);
      filter.close();
    }
  });

  it("keeps each service stream independent when the same chunks are shared and flushed together", async () => {
    const packets = [];
    for (let i = 0; i < 400; i++) {
      const pid = [0, 0x1F0, 0x1F1, 0x100, 0x110, 0x200, 0x1FFF, 0x100, 0x200, 0x300][i % 10];
      packets.push(pid === 0 ? patPacket(i) : pid === 0x1F0 ? pmt1024Packet(i) : pid === 0x1F1 ? pmt1025Packet(i) : packet(pid, i));
    }
    const ts = Buffer.concat(packets);
    const original = Buffer.from(ts);

    for (const sizes of [[ts.length], [188 * 7], [1, 187, 189, 5000], [100, 88, 7, 3000]]) {
      const services = [1024, 1025].map(serviceId => {
        const output = collector(1024 * 1024);
        const filter = new TSFilter({ output, serviceId });
        return { serviceId, output, filter };
      });
      for (const { filter } of services) {
        filter.write(Buffer.concat([patPacket(0), pmt1024Packet(0), pmt1025Packet(0)]));
      }
      await tick();
      for (const { filter } of services) {
        filter.write(Buffer.concat([pmt1024Packet(1), pmt1025Packet(1)]));
      }
      await tick();

      // TunerDevice と同じく、同じチャンクを全ストリームに渡してからまとめて書き出す
      let pos = 0;
      for (let i = 0; pos < ts.length; i++) {
        const chunk = ts.subarray(pos, pos + sizes[i % sizes.length]);
        for (const { filter } of services) {
          filter.write(chunk, true);
        }
        if (i % 3 === 2) {
          for (const { filter } of services) {
            filter.flush();
          }
        }
        pos += chunk.length;
      }
      for (const { filter } of services) {
        filter.flush();
      }

      // 共有している入力のチャンクは書き換えない
      assert.ok(ts.equals(original), `chunk sizes: ${sizes}`);

      for (const { serviceId, output, filter } of services) {
        const pids = serviceId === 1024 ? [0x1F0, 0x100, 0x110] : [0x1F1, 0x200];
        const expected = [];
        for (const p of packets) {
          const pid = p.readUInt16BE(1) & 0x1FFF;
          if (pid === 0) {
            expected.push(Buffer.concat([p.subarray(0, 5), filter._patsec]));
          } else if (pids.includes(pid)) {
            expected.push(p);
          }
        }
        assert.ok(output.result().equals(Buffer.concat(expected)), `serviceId: ${serviceId}, chunk sizes: ${sizes}`);
        filter.close();
      }
    }
  });

  it("writes the deferred packets when closed", () => {
    const packets = [];
    for (let i = 0; i < 20; i++) {
      packets.push(packet(0x100, i));
    }
    const output = collector(1024 * 1024);
    const filter = new TSFilter({ output });
    filter.write(patPacket(0));

    filter.write(Buffer.concat(packets), true);
    assert.ok(output.result().equals(patPacket(0)));
    filter.close();

    assert.ok(output.result().equals(Buffer.concat([patPacket(0), ...packets])));
  });

  it("does not defer the output until the PAT is written", () => {
    const output = collector(1024 * 1024);
    const filter = new TSFilter({ output });

    // PAT より前のパケットを出力しただけでは、出力を始めたとしない
    filter.write(packet(0x100, 0), true);
    filter.write(patPacket(1), true);
    assert.ok(output.result().equals(Buffer.concat([packet(0x100, 0), patPacket(1)])));

    filter.write(packet(0x100, 2), true);
    assert.strictEqual(output.result().length, 188 * 2);
    filter.close();
  });

  it("counts only the PAT queued after ready and not trimmed", async () => {
    // 準備ができる前の PAT は、上限を超えて破棄される場合があるため数えない
    const waiting = new TSFilter({ output: collector(1024 * 1024), serviceId: 1024 });
    waiting.write(patPacket(0), true);
    assert.strictEqual(waiting._patBuffered, false);
    waiting.close();

    // 出力が詰まっている間に上限を超えて破棄した場合は、PAT を書き出したとしない
    const output = new Writable({ highWaterMark: 188, write() { /* 書き終えない */ } });
    const filter = new TSFilter({ output });
    filter.write(packet(0x100, 0), true);
    filter.write(patPacket(1), true);
    assert.strictEqual(filter._patBuffered, true);
    for (let i = 2; i < 10; i++) {
      filter.write(packet(0x100, i), true);
    }
    assert.strictEqual(filter._patBuffered, false);
    filter.close();

    // 最初の PAT を書き出した後は、詰まって破棄しても最初の PAT を書き出したままとする (入力ごとに書き出さない)
    const stalled = new Writable({ highWaterMark: 188, write() { /* 書き終えない */ } });
    const started = new TSFilter({ output: stalled });
    started.write(patPacket(0), true);
    assert.strictEqual(started._patWritten, true);
    for (let i = 1; i < 10; i++) {
      started.write(packet(0x100, i), true);
    }
    assert.strictEqual(started._bufferBytes, 188 * 9);
    started.flush();
    assert.ok(started._bufferBytes < 188 * 9);
    assert.strictEqual(started._patWritten, true);
    assert.strictEqual(started._patBuffered, true);
    started.close();
  });

  it("defers the output while waiting for the event", () => {
    const filter = new TSFilter({ output: collector(1024 * 1024), serviceId: 1, eventId: 1 });

    // 準備ができるまでは出力できないため、入力ごとに保持するためのコピーをしない
    filter.write(packet(0x11, 0), true);
    filter.write(packet(0x11, 1), true);
    assert.ok(Buffer.concat(filter._buffer).equals(Buffer.concat([packet(0x11, 0), packet(0x11, 1)])));
    assert.strictEqual(filter._bufferRetainedCount, 0);
    filter.close();
  });

  it("writes the deferred packets when the provided event has ended", async () => {
    const output = collector(1024 * 1024);
    const filter = new TSFilter({ output, serviceId: 1, eventId: 1 });
    filter._ready = true;
    filter._pmtPid = 0x1F0;
    filter._providePids = null;
    filter._eventEndTimeout = 10;

    const p = packet(0x100, 0);
    filter.write(p, true);
    // 次の番組の EIT p/f を受け取ると、eventEndTimeout の後に閉じる
    filter._onEIT(0x12, { table_id: 0x4E, section_number: 0, service_id: 1, events: [{ event_id: 2 }] });
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.strictEqual(filter.closed, true);
    assert.ok(output.result().equals(p));
  });

  it("parses EIT only in the filter that writes EPG for the network", async () => {
    const status = require("../lib/Mirakurun/status").default;
    const eit = packet(0x12, 0);
    const parsed = filter => {
      let count = 0;
      const write = filter._parser.write.bind(filter._parser);
      filter._parser.write = buffers => {
        count += buffers.filter(b => (b.readUInt16BE(1) & 0x1FFF) === 0x12).length;
        return write(buffers);
      };
      return () => count;
    };

    status.epg[1] = true;
    const other = new TSFilter({ output: collector(1024 * 1024), networkId: 1, parseEIT: true });
    const otherCount = parsed(other);
    other.write(eit);
    await tick();
    // 他のフィルターが EPG を書き込んでいるネットワークの EIT は解析しない
    assert.strictEqual(otherCount(), 0);

    // 書き込んでいたフィルターが閉じたら引き継ぐ
    status.epg[1] = false;
    other.write(eit);
    await tick();
    assert.strictEqual(otherCount(), 1);
    other.close();

    // 番組を指定したストリームは、番組の開始と終了の検出に EIT を使うため常に解析する
    status.epg[1] = true;
    const program = new TSFilter({ output: collector(1024 * 1024), networkId: 1, serviceId: 1, eventId: 1, parseEIT: true });
    const programCount = parsed(program);
    program.write(eit);
    await tick();
    assert.strictEqual(programCount(), 1);
    program.close();
    delete status.epg[1];
  });
});
