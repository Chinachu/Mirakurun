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

function nit(networkId, transportStreams, tableId = 0x40) {
  const loop = transportStreams.flatMap(([tsid, services, remoteControlKeyId]) => {
    // service list descriptor
    const desc = [0x41, services.length * 3, ...services.flatMap(([serviceId, type]) => [...u16(serviceId), type])];
    if (remoteControlKeyId !== undefined) {
      // TS information descriptor (ts_name なし、transmission_type_count = 0)
      desc.unshift(0xCD, 2, remoteControlKeyId, 0x00);
    }
    return [...u16(tsid), ...u16(networkId), ...u16(0xF000 | desc.length), ...desc];
  });
  return sectionPacket(0x10, tableId, networkId, [...u16(0xF000), ...u16(0xF000 | loop.length), ...loop]);
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
  });

  it("does not report the remoteControlKeyId of another transport stream for CATV", async () => {
    const [f, events] = filter(0xFFFE);
    await write(f, [
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
      // 別の TS だけを載せたセクションの後に、この TS を載せたセクションが届く
      nit(0xFFFE, [[0x0421, [[0x0410, 0x01], [98, 0xA4]], 5]]),
      nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]], 9]]),
      // この TS のセクションが届いた後は通知しない
      nit(0xFFFE, [[0x0421, [[0x0410, 0x01]], 5]])
    ]);
    f.close();

    // 別の TS の値 (5) は通知せず、この TS のセクションが届いたら通知し直す
    assert.deepStrictEqual(events.network.map(n => n.remoteControlKeyId), [-1, 9]);
  });

  it("reports the remoteControlKeyId of its own transport stream when the NIT lists it", async () => {
    // BS の NIT は 1 つのセクションに多数の TS を載せるため、自身の TS は先頭ではない
    const [f, events] = filter(4, { parseNIT: true });
    await write(f, [
      pat([[0, 0x10], [101, 0x1F0]]),
      nit(4, [[0x4010, [[103, 0x01]], 5], [TSID, [[101, 0x01]], 9]])
    ]);
    f.close();

    assert.deepStrictEqual(events.network.map(n => n.remoteControlKeyId), [9]);
  });

  it("falls back to the first transport stream as before except for CATV", async () => {
    const [f, events] = filter(4, { parseNIT: true });
    await write(f, [
      pat([[0, 0x10], [101, 0x1F0]]),
      nit(4, [[0x4010, [[103, 0x01]], 5]])
    ]);
    f.close();

    assert.deepStrictEqual(events.network.map(n => n.remoteControlKeyId), [5]);
  });

  it("ignores the NIT other, which can carry another network with the same transport_stream_id", async () => {
    const [f, events] = filter(0xFFFE, { parseSDT: true });
    await write(f, [
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
      // 他のネットワークが同じ transport_stream_id の TS で 0x0400 を ESS として載せている
      nit(0x7FE0, [[TSID, [[0x0400, 0xA4]], 3]], 0x41),
      nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]], 9]]),
      sdt(0xFFFE, [[0x0400, 0x01, "TV"], [97, 0xA4, "ESS"]])
    ]);
    f.close();

    // 他のネットワークの ESS や remoteControlKeyId を取り込まない
    assert.deepStrictEqual(events.services.map(services => services.map(s => s.serviceId)), [[0x0400]]);
    assert.deepStrictEqual(events.network.map(n => [n.networkId, n.remoteControlKeyId]), [[0xFFFE, 9]]);
    const detected = logs.filter(([format]) => format.startsWith("TSFilter#_detectEss"));
    assert.deepStrictEqual(detected.map(args => args.slice(1)), [[0x1F2, 97]]);
  });

  it("keeps the notified network when the PAT is updated without changing the transport stream", async () => {
    const [f, events] = filter(0xFFFE);
    await write(f, [
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
      nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]], 9]]),
      // PAT が更新されても、自身の TS を含まないセクションで通知し直さない
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2], [0x0401, 0x1F6]]),
      nit(0xFFFE, [[0x0421, [[0x0410, 0x01]], 5]])
    ]);
    f.close();

    assert.deepStrictEqual(events.network.map(n => n.remoteControlKeyId), [9]);
  });

  it("keeps the detected ESS out of the services when the PAT is updated", async () => {
    const [f, events] = filter(0xFFFE, { parseSDT: true });
    await write(f, [
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
      nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]]]]),
      // ESS の PMT PID が変わった PAT が届く (SDT に service_type がない場合も除外する)
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F4]]),
      sdt(0xFFFE, [[0x0400, 0x01, "TV"], [97, 0x01, "ESS"]])
    ]);
    f.close();

    assert.deepStrictEqual(events.services.map(services => services.map(s => s.serviceId)), [[0x0400]]);
    const changed = logs.filter(([format]) => format.includes("ESS PMT PID has changed"));
    assert.deepStrictEqual(changed.map(args => args.slice(1)), [[0x1F4, 0x1F2, 97]]);
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
