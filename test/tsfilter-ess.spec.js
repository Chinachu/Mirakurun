const { describe, it, before, beforeEach } = require("node:test");
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
function sectionPacket(pid, tableId, idExtension, body) {
  const length = 5 + body.length + 4;
  const section = [tableId, (tableId === 0x00 ? 0xB0 : 0xF0) | (length >> 8), length & 0xFF, ...u16(idExtension), 0xC1, 0, 0, ...body];
  const p = Buffer.alloc(188, 0xFF);
  p[0] = 0x47;
  p[1] = 0x40 | (pid >> 8);
  p[2] = pid & 0xFF;
  p[3] = 0x10 | (cc++ & 0x0F);
  p[4] = 0; // pointer_field
  Buffer.from(section).copy(p, 5);
  p.writeUInt32BE(crc32(section), 5 + section.length);
  return p;
}

const TSID = 0x0420;

function pat(programs) {
  return sectionPacket(0, 0x00, TSID, programs.flatMap(([number, pid]) => [...u16(number), ...u16(0xE000 | pid)]));
}

function sdt(networkId, services) {
  return sectionPacket(0x11, 0x42, TSID, [
    ...u16(networkId), 0xFF,
    ...services.flatMap(([serviceId, type, name]) => {
      const desc = [0x48, 3 + name.length, type, 0, name.length, ...Buffer.from(name)];
      return [...u16(serviceId), 0xFC, ...u16(0x8000 | desc.length), ...desc];
    })
  ]);
}

function nit(networkId, transportStreams) {
  const loop = transportStreams.flatMap(([tsid, services]) => {
    const desc = [0x41, services.length * 3, ...services.flatMap(([serviceId, type]) => [...u16(serviceId), type])];
    return [...u16(tsid), ...u16(networkId), ...u16(0xF000 | desc.length), ...desc];
  });
  return sectionPacket(0x10, 0x40, networkId, [...u16(0xF000), ...u16(0xF000 | loop.length), ...loop]);
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// 解析は書き込みの後に行い、PAT などの結果で次のパケットを解析するかを決めるため、1 パケットずつ解析を待つ
async function write(f, packets) {
  for (const p of packets) {
    f.write(p);
    await tick();
  }
}

function filter(networkId, options = {}) {
  const output = new Writable({ write: (chunk, encoding, callback) => callback() });
  const f = new TSFilter({ output, networkId, ...options });
  const events = { services: [], network: [] };
  f.on("services", services => events.services.push(services));
  f.on("network", network => events.network.push(network));
  return [f, events];
}

describe("[tsfilter-ess.spec] TSFilter.ts: ESS", () => {
  let logs;
  before(() => {
    _.config = { server: {} };
    _.program = { get: () => null };
    _.service = { get: () => null, findByNetworkId: () => [] };
    for (const level of ["info", "warn", "error"]) {
      log[level] = () => {};
    }
    log.debug = (...args) => logs.push(args);
    TSFilter = require("../lib/Mirakurun/TSFilter").default;
  });
  beforeEach(() => logs = []);

  it("does not provide the engineering services (service_type 0xA4) as services", async () => {
    const [f, events] = filter(0xFFFE, { parseSDT: true });
    await write(f, [
      pat([[0x0400, 0x1F0], [97, 0x1F2]]),
      sdt(0xFFFE, [[0x0400, 0x01, "TV"], [97, 0xA4, "ESS"]])
    ]);
    f.close();

    assert.deepStrictEqual(events.services.map(services => services.map(s => s.serviceId)), [[0x0400]]);
  });

  it("does not provide the ESS of BS (serviceId 929) as a service as before", async () => {
    const [f, events] = filter(4, { parseSDT: true });
    await write(f, [
      pat([[101, 0x1F0], [929, 0x1F2]]),
      sdt(4, [[101, 0x01, "BS"], [929, 0xA4, "ESS"]])
    ]);
    f.close();

    assert.deepStrictEqual(events.services.map(services => services.map(s => s.serviceId)), [[101]]);
  });

  it("detects the ESS of CATV by service_type in the NIT section of the transport stream", async () => {
    const [f, events] = filter(0xFFFE);
    await write(f, [
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
      // 別の TS だけを載せたセクションの後に、この TS を載せたセクションが届く
      nit(0xFFFE, [[0x0421, [[0x0410, 0x01], [98, 0xA4]]]]),
      nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]]]])
    ]);
    f.close();

    const detected = logs.filter(([format]) => format.startsWith("TSFilter#_detectEss"));
    assert.deepStrictEqual(detected.map(args => args.slice(1)), [[0x1F2, 97]]);
    // network は従来どおり 1 回だけ通知する
    assert.strictEqual(events.network.length, 1);
  });

  it("does not detect ESS by NIT for GR", async () => {
    const [f] = filter(0x7FE0, { parseNIT: true });
    await write(f, [
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
      nit(0x7FE0, [[TSID, [[0x0400, 0x01], [97, 0xA4]]]])
    ]);
    f.close();

    assert.strictEqual(logs.filter(([format]) => format.startsWith("TSFilter#_detectEss")).length, 0);
  });
});
