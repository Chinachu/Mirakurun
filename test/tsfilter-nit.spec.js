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

const u16 = n => [(n >> 8) & 0xFF, n & 0xFF];

let cc = 0;
function sectionPacket(pid, tableId, idExtension, body, { version = 0, current = 1, section = 0, last = 0 } = {}) {
  const length = 5 + body.length + 4;
  const data = [tableId, (tableId === 0x00 ? 0xB0 : 0xF0) | (length >> 8), length & 0xFF, ...u16(idExtension), 0xC0 | (version << 1) | current, section, last, ...body];
  const p = Buffer.alloc(188, 0xFF);
  p[0] = 0x47;
  p[1] = 0x40 | (pid >> 8);
  p[2] = pid & 0xFF;
  p[3] = 0x10 | (cc++ & 0x0F);
  p[4] = 0; // pointer_field
  Buffer.from(data).copy(p, 5);
  p.writeUInt32BE(crc32(data), 5 + data.length);
  return p;
}

const TSID = 0x4010;
const pat = (serviceIds = [151]) => sectionPacket(0, 0x00, TSID, [
  ...u16(0), ...u16(0xE010),
  ...serviceIds.flatMap((serviceId, index) => [...u16(serviceId), ...u16(0xE1F0 + index)])
]);

// transportStreams: [TSID, the frequency (8 digits of BCD, 10 kHz) of the satellite delivery system descriptor]
function nit(networkId, transportStreams, options = {}, tableId = 0x40) {
  const loop = transportStreams.flatMap(([tsid, frequency]) => {
    const desc = frequency === undefined ? [] : [0x43, 11, ...Buffer.from(frequency, "hex"), 0x11, 0x00, 0x68, 0x02, 0x88, 0x60, 0x08];
    return [...u16(tsid), ...u16(networkId), ...u16(0xF000 | desc.length), ...desc];
  });
  return sectionPacket(0x10, tableId, networkId, [...u16(0xF000), ...u16(0xF000 | loop.length), ...loop], options);
}

function sdt(services) {
  return sectionPacket(0x11, 0x42, TSID, [
    ...u16(4), 0xFF,
    ...services.flatMap(([serviceId, type, freeCaMode]) => {
      const descriptor = [0x48, 5, type, 0, 2, 0x54, 0x56];
      return [...u16(serviceId), 0xFC, ...u16(0x8000 | (freeCaMode << 12) | descriptor.length), ...descriptor];
    })
  ]);
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// 解析は書き込みの後に行い、PAT などの結果で次のパケットを解析するかを決めるため、1 パケットずつ解析を待つ
async function write(f, packets) {
  for (const p of packets) {
    f.write(p);
    await tick();
  }
}

function filter(options = {}) {
  const output = new Writable({ write: (chunk, encoding, callback) => callback() });
  const f = new TSFilter({ output, networkId: 4, parseNIT: true, ...options });
  const events = { network: [], networkStreams: [] };
  f.on("network", network => events.network.push(network));
  f.on("networkStreams", networkStreams => events.networkStreams.push(networkStreams));
  return [f, events];
}

describe("[tsfilter-nit.spec] TSFilter.ts: the streams of the network by NIT", () => {
  before(() => {
    _.config = { server: {} };
    _.program = { get: () => null };
    _.service = { get: () => null, findByNetworkId: () => [] };
    for (const level of ["debug", "info", "warn", "error"]) {
      log[level] = () => {};
    }
    TSFilter = require("../lib/Mirakurun/TSFilter").default;
  });

  // 自身の TS のセクションで network を通知した後も、すべてのセクションがそろうまで NIT を解析する
  it("collects the streams of all the sections of NIT, notified once", async () => {
    const [f, events] = filter({ parseNetworkStreams: true });
    await write(f, [
      pat(),
      nit(4, [[TSID, "01172748"], [0x4011, "01172748"]], { last: 1 })
    ]);
    assert.strictEqual(events.network.length, 1);
    assert.deepStrictEqual(events.networkStreams, []);

    await write(f, [
      // the same section again, NIT other
      nit(4, [[TSID, "01172748"], [0x4011, "01172748"]], { last: 1 }),
      nit(6, [[0x6020, "01229100"]], {}, 0x41),
      // the frequency is not BCD, without the descriptor
      nit(4, [[0x48F3, "01199600"], [0x4090, "0118809A"], [0x4092]], { section: 1, last: 1 }),
      nit(4, [[TSID, "01172748"]], { last: 1 }),
      nit(4, [[0x48F3, "01199600"]], { section: 1, last: 1 })
    ]);
    f.close();

    assert.deepStrictEqual(events.networkStreams, [{
      networkId: 4,
      streams: [
        { streamId: TSID, frequency: 11727480 },
        { streamId: 0x4011, frequency: 11727480 },
        { streamId: 0x48F3, frequency: 11996000 },
        { streamId: 0x4090 },
        { streamId: 0x4092 }
      ]
    }]);
    assert.strictEqual(events.network.length, 1);
  });

  it("collects the sections of the same version, not of the next", async () => {
    const [f, events] = filter({ parseNetworkStreams: true });
    await write(f, [
      pat(),
      nit(4, [[TSID, "01172748"]], { version: 1, last: 1 }),
      // the next version (not yet applicable, not collected with the sections of the version when updated), and updated
      nit(4, [[0x4631, "01176584"]], { version: 2, current: 0, last: 1 }),
      nit(4, [[0x4030, "01176584"]], { version: 2, section: 1, last: 1 })
    ]);
    assert.deepStrictEqual(events.networkStreams, []);

    await write(f, [nit(4, [[TSID, "01172748"], [0x4011, "01172748"]], { version: 2, last: 1 })]);
    f.close();

    assert.deepStrictEqual(events.networkStreams.map(network => network.streams.map(stream => stream.streamId)), [[TSID, 0x4011, 0x4030]]);
  });

  // TSMF の相対 TS が混ざったストリームでは、別のネットワークの NIT も届く
  it("does not mix the sections of the different networks", async () => {
    const [f, events] = filter({ parseNetworkStreams: true });
    await write(f, [
      pat(),
      nit(4, [[TSID, "01172748"]], { last: 1 }),
      nit(0xFFFE, [[0x0420]], { section: 1, last: 1 })
    ]);
    assert.deepStrictEqual(events.networkStreams, []);

    await write(f, [nit(0xFFFE, [[0x0421]], { last: 1 })]);
    f.close();

    assert.deepStrictEqual(events.networkStreams, [{ networkId: 0xFFFE, streams: [{ streamId: 0x0421 }, { streamId: 0x0420 }] }]);
  });

  it("ignores an out-of-range section before completing or resetting the network version", async () => {
    const [f, events] = filter({ parseNetworkStreams: true });
    try {
      await write(f, [pat(), nit(4, [[0x4999]], { section: 1, last: 0 })]);
      assert.deepStrictEqual(events.networkStreams, []);
      await write(f, [
        nit(4, [[TSID]], { version: 1, section: 0, last: 1 }),
        nit(4, [[0x4999]], { version: 2, section: 2, last: 1 }),
        nit(4, [[0x4011]], { version: 1, section: 1, last: 1 })
      ]);
      assert.deepStrictEqual(events.networkStreams, [{ networkId: 4, streams: [{ streamId: TSID }, { streamId: 0x4011 }] }]);
    } finally { f.close(); }
  });

  it("notifies a repeated SDT serviceId once and keeps its first metadata", async () => {
    const [f] = filter({ parseSDT: true });
    const services = [];
    f.on("services", rows => services.push(rows));
    try {
      await write(f, [pat([151, 152]), nit(4, [[TSID]]), sdt([
        [151, 0x01, 0],
        [151, 0xA5, 1],
        [152, 0x02, 1],
        [151, 0xA5, 1],
        [153, 0x01, 0] // PATにないサービスは通知しない。
      ])]);
      assert.strictEqual(services.length, 1);
      assert.deepStrictEqual(services[0].map(({ networkId, serviceId, streamId, type, isFree }) =>
        ({ networkId, serviceId, streamId, type, isFree })), [
        { networkId: 4, serviceId: 151, streamId: TSID, type: 0x01, isFree: true },
        { networkId: 4, serviceId: 152, streamId: TSID, type: 0x02, isFree: false }
      ]);
    } finally { f.close(); }
  });

  it("keeps different SDT serviceIds even when their descriptors are identical", async () => {
    const [f] = filter({ parseSDT: true });
    const services = [];
    f.on("services", rows => services.push(rows));
    try {
      await write(f, [pat([151, 152]), nit(4, [[TSID]]), sdt([
        [151, 0x01, 0],
        [152, 0x01, 0]
      ])]);
      assert.strictEqual(services.length, 1);
      assert.deepStrictEqual(services[0].map(service => service.serviceId), [151, 152]);
      assert.strictEqual(services[0][0].name, services[0][1].name);
      assert.ok(services[0][0].name);
    } finally { f.close(); }
  });

  it("does not collect the streams of the network by default", async () => {
    const [f, events] = filter();
    await write(f, [pat(), nit(4, [[TSID, "01172748"]]), nit(4, [[TSID, "01172748"]])]);
    f.close();

    assert.strictEqual(events.network.length, 1);
    assert.deepStrictEqual(events.networkStreams, []);
  });
});
