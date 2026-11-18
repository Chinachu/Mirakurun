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
function sectionPacket(pid, tableId, idExtension, body, sectionNumber = 0, lastSectionNumber = 0, versionNumber = 0) {
  const length = 5 + body.length + 4;
  const section = [tableId, (tableId === 0x00 ? 0xB0 : 0xF0) | (length >> 8), length & 0xFF, ...u16(idExtension), 0xC1 | (versionNumber << 1), sectionNumber, lastSectionNumber, ...body];
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

function nit(networkId, transportStreams, tableId = 0x40, sectionNumber = 0, lastSectionNumber = 0, versionNumber = 0) {
  const loop = transportStreams.flatMap(([tsid, services, remoteControlKeyId]) => {
    // service list descriptor
    const desc = [0x41, services.length * 3, ...services.flatMap(([serviceId, type]) => [...u16(serviceId), type])];
    if (remoteControlKeyId !== undefined) {
      // TS information descriptor (ts_name なし、transmission_type_count = 0)
      desc.unshift(0xCD, 2, remoteControlKeyId, 0x00);
    }
    return [...u16(tsid), ...u16(networkId), ...u16(0xF000 | desc.length), ...desc];
  });
  return sectionPacket(0x10, tableId, networkId, [...u16(0xF000), ...u16(0xF000 | loop.length), ...loop], sectionNumber, lastSectionNumber, versionNumber);
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
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
      nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]]]]),
      sdt(0xFFFE, [[0x0400, 0x01, "TV"], [97, 0xA4, "ESS"]])
    ]);
    f.close();

    assert.deepStrictEqual(events.services.map(services => services.map(s => s.serviceId)), [[0x0400]]);
  });

  it("地上波でもESSは通常のサービス一覧から除外する（地上波のロゴはCDTで受信）", async () => {
    const [f, events] = filter(0x7FE0, { parseSDT: true });
    await write(f, [
      pat([[0x0400, 0x1F0], [97, 0x1F2]]),
      sdt(0x7FE0, [[0x0400, 0x01, "TV"], [97, 0xA4, "ESS"]])
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
      nit(0xFFFE, [[0x0421, [[0x0410, 0x01], [98, 0xA4]]]], 0x40, 0, 1),
      nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]]]], 0x40, 1, 1)
    ]);
    f.close();

    const detected = logs.filter(([format]) => format.startsWith("TSFilter#_detectEss"));
    assert.deepStrictEqual(detected.map(args => args.slice(1)), [[0x1F2, 97]]);
  });

  it("CATVでSDTが先に届いても自TSのNITでESSを判定してから最初の一覧を通知する", async () => {
    const [f, events] = filter(0xFFFE, { parseSDT: true });
    try {
      await write(f, [
        pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
        sdt(0xFFFE, [[0x0400, 0x01, "TV"], [97, 0x01, "ESS"]])
      ]);
      assert.deepStrictEqual(events.services, []);
      await write(f, [nit(0xFFFE, [[0x0421, [[0x0410, 0x01], [98, 0xA4]]]], 0x40, 0, 1)]);
      assert.deepStrictEqual(events.services, []);
      await write(f, [nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]]]], 0x40, 1, 1)]);
      assert.deepStrictEqual(events.services.map(services => services.map(s => s.serviceId)), [[0x0400]]);
      await write(f, [sdt(0xFFFE, [[0x0400, 0x01, "TV"], [97, 0x01, "ESS"]])]);
      assert.strictEqual(events.services.length, 1);
    } finally { f.close(); }
  });

  for (const nitFirst of [false, true]) {
    it(`networkId未指定のスキャンもCATVを検出してESSを除外する (NIT先着=${nitFirst})`, async () => {
      const [f, events] = filter(undefined, { parseNIT: true, parseSDT: true });
      try {
        const patPacket = pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]);
        const nitPacket = nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]]]]);
        const sdtPacket = sdt(0xFFFE, [[0x0400, 0x01, "TV"], [97, 0x01, "ESS"]]);
        await write(f, [patPacket, ...(nitFirst ? [nitPacket, sdtPacket] : [sdtPacket])]);
        if (!nitFirst) {
          assert.deepStrictEqual(events.services, []);
          await write(f, [nitPacket]);
        }
        assert.deepStrictEqual(events.services.map(services => services.map(s => s.serviceId)), [[0x0400]]);
      } finally { f.close(); }
    });
  }

  for (const targetNetworkId of [undefined, 0xFFFE]) {
    for (const parseNetworkStreams of [false, true]) {
      it(`CATVの全NITセクションに自TSが無いときSDTの保留を解除する (target=${targetNetworkId}, collect=${parseNetworkStreams})`, async () => {
        const [f, events] = filter(targetNetworkId, { parseNIT: true, parseSDT: true, parseNetworkStreams });
        try {
          await write(f, [
            pat([[0, 0x10], [0x0400, 0x1F0]]),
            sdt(0xFFFE, [[0x0400, 0x01, "TV"]]),
            // 同じセクションの重複では全セクション取得済みにならない。
            nit(0xFFFE, [[0x0421, [[0x0410, 0x01]], 5]], 0x40, 1, 1),
            nit(0xFFFE, [[0x0421, [[0x0410, 0x01]], 5]], 0x40, 1, 1)
          ]);
          assert.deepStrictEqual(events.services, []);
          await write(f, [nit(0xFFFE, [[0x0422, [[0x0420, 0x01]], 6]], 0x40, 0, 1)]);
          assert.deepStrictEqual(events.services.map(services => services.map(service => service.serviceId)), [[0x0400]]);
          // 他TSのリモコン番号を自TSの情報としては採用しない。
          assert.deepStrictEqual(events.network.map(network => network.remoteControlKeyId), [-1]);
          assert.strictEqual(f._pendingSDT, null);
        } finally { f.close(); }
      });
    }
  }

  it("CATVのNITは別versionのセクションを混ぜず、完了後に到着したSDTも通知する", async () => {
    const [f, events] = filter(undefined, { parseNIT: true, parseSDT: true });
    try {
      await write(f, [
        pat([[0, 0x10], [0x0400, 0x1F0]]),
        nit(0xFFFE, [[0x0421, [[0x0410, 0x01]]]], 0x40, 0, 1, 0),
        nit(0xFFFE, [[0x0422, [[0x0420, 0x01]]]], 0x40, 1, 1, 1),
        sdt(0xFFFE, [[0x0400, 0x01, "TV"]])
      ]);
      assert.deepStrictEqual(events.services, []);
      await write(f, [nit(0xFFFE, [[0x0421, [[0x0410, 0x01]]]], 0x40, 0, 1, 1)]);
      assert.deepStrictEqual(events.services.map(services => services.map(service => service.serviceId)), [[0x0400]]);
    } finally { f.close(); }
  });

  it("CATVの全NIT受信後に到着したSDTも自TSなしで通知する", async () => {
    const [f, events] = filter(undefined, { parseNIT: true, parseSDT: true });
    try {
      await write(f, [
        pat([[0, 0x10], [0x0400, 0x1F0]]),
        nit(0xFFFE, [[0x0421, [[0x0410, 0x01]]]]),
        sdt(0xFFFE, [[0x0400, 0x01, "TV"]])
      ]);
      assert.deepStrictEqual(events.services.map(services => services.map(service => service.serviceId)), [[0x0400]]);
    } finally { f.close(); }
  });

  for (const nitFirst of [false, true]) {
    for (const parseNetworkStreams of [false, true]) {
      it(`NITとSDTのnetworkIdが違ってもCATVのSDTを保留し続けない (nitFirst=${nitFirst}, collect=${parseNetworkStreams})`, async () => {
        const [f, events] = filter(undefined, { parseNIT: true, parseSDT: true, parseNetworkStreams });
        try {
          const network = nit(4, [[0x4011, [[101, 0x01]]]]);
          const services = sdt(0xFFFE, [[0x0400, 0x01, "TV"]]);
          await write(f, [pat([[0, 0x10], [0x0400, 0x1F0]]), ...(nitFirst ? [network, services] : [services, network])]);
          assert.deepStrictEqual(events.services.map(items => items.map(service => service.serviceId)), [[0x0400]]);
          assert.strictEqual(f._pendingSDT, null);
        } finally { f.close(); }
      });
    }
  }

  it("networkId未指定の非CATVスキャンはSDTだけで一覧を通知する", async () => {
    const [f, events] = filter(undefined, { parseNIT: true, parseSDT: true });
    await write(f, [pat([[0, 0x10], [101, 0x1F0]]), sdt(4, [[101, 0x01, "BS"]])]);
    f.close();
    assert.deepStrictEqual(events.services.map(services => services.map(s => s.serviceId)), [[101]]);
  });

  it("CATVでNIT待ちのまま閉じたSDTは後から通知しない", async () => {
    const [f, events] = filter(0xFFFE, { parseSDT: true });
    await write(f, [
      pat([[0, 0x10], [0x0400, 0x1F0]]),
      sdt(0xFFFE, [[0x0400, 0x01, "TV"]])
    ]);
    f.close();
    await tick();
    assert.deepStrictEqual(events.services, []);
  });

  it("does not report the remoteControlKeyId of another transport stream for CATV", async () => {
    const [f, events] = filter(0xFFFE);
    await write(f, [
      pat([[0, 0x10], [0x0400, 0x1F0], [97, 0x1F2]]),
      // 別の TS だけを載せたセクションの後に、この TS を載せたセクションが届く
      nit(0xFFFE, [[0x0421, [[0x0410, 0x01], [98, 0xA4]], 5]], 0x40, 0, 1),
      nit(0xFFFE, [[TSID, [[0x0400, 0x01], [97, 0xA4]], 9]], 0x40, 1, 1),
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


  it("DSMCCのロゴ待機期限で未完成モジュールを解放し、フィルター自体は継続する", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const Service = require("../lib/Mirakurun/Service").default;
    t.mock.method(Service, "getLogoDataMTime", async () => 0);
    const previous = _.service, service = { networkId: 0xFFFE, serviceId: 101, logoId: 1 };
    _.service = { get: () => service, findByNetworkId: () => [service] };
    t.after(() => { _.service = previous; });
    const [f] = filter(0xFFFE);
    try {
      await write(f, [pat([[0, 0x10], [101, 0x1F0], [97, 0x1F2]]), nit(0xFFFE, [[TSID, [[101, 0x01], [97, 0xA4]]]])]);
      await f._standbyLogoData();
      assert.strictEqual(f._parser.listenerCount("dsmcc"), 1);
      f._onDSMCC(0x771, dii(1, 4 * 1024 * 1024, 1024));
      f._onDSMCC(0x771, ddb(1, 0, Buffer.alloc(1024)));
      assert.strictEqual(f._dlDataMap.size, 1);
      assert.strictEqual([...f._dlDataMap.values()][0].loadedBlocks.size, 1);
      t.mock.timers.tick(30 * 60 * 1000 - 1);
      assert.strictEqual(f._dlDataMap.size, 1, "受信期限までは未保存の受信途中データを保持します");
      t.mock.timers.tick(1);
      assert.strictEqual(f.closed, false);
      assert.strictEqual(f._dlDataMap.size, 0, "購読終了後に完成できないデータを保持しません");
      assert.strictEqual(f._logoDataTimer, undefined);
      assert.strictEqual(f._parser.listenerCount("dsmcc"), 0);
    } finally { f.close(); }
  });

  it("CATVのロゴ待機中に追加検出したESSのPMTも解析し、待機を二重登録しない", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const Service = require("../lib/Mirakurun/Service").default;
    t.mock.method(Service, "getLogoDataMTime", async () => 0);
    const previous = _.service, service = { networkId: 0xFFFE, serviceId: 101, logoId: 1 };
    _.service = { get: () => service, findByNetworkId: () => [service] };
    t.after(() => { _.service = previous; });
    const [f] = filter(0xFFFE);
    try {
      await write(f, [pat([[0, 0x10], [101, 0x1F0], [97, 0x1F2], [98, 0x1F4]]), nit(0xFFFE, [[TSID, [[101, 0x01], [97, 0xA4]]]])]);
      f._epg = { end() {} };
      await f._standbyLogoData();
      const timer = f._logoDataTimer;
      assert.ok(timer);
      f._detectEss([{ service_id: 98, service_type: 0xA4 }]);
      assert.ok(f._parsePids.has(0x1F4), "待機中に見つかったESSもPMTの解析対象にします");
      await write(f, [sectionPacket(0x1F4, 0x02, 98, [
        ...u16(0xE771), ...u16(0xF000), 0x0D, ...u16(0xE771), ...u16(0xF003), 0x52, 1, 0x79
      ])]);
      assert.ok(f._essEsPids.has(0x771), "追加ESSのPMTからロゴESを検出します");
      assert.strictEqual(f._logoDataTimer, timer);
      assert.strictEqual(f._parser.listenerCount("dsmcc"), 1);
    } finally { f.close(); }
  });

  for (const networkId of [0x7FE0, 0xFFFE]) {
    it(`ロゴ準備の照会中は待機を二重登録せず、closeですべて解除する (networkId=${networkId})`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const Service = require("../lib/Mirakurun/Service").default;
      const gate = Promise.withResolvers();
      let lookups = 0;
      let timers = 0;
      let fired = 0;
      const setTimeout = global.setTimeout;
      t.mock.method(global, "setTimeout", (callback, delay, ...args) => {
        if (delay !== 30 * 60 * 1000) { return setTimeout(callback, delay, ...args); }
        ++timers;
        return setTimeout(() => { ++fired; callback(...args); }, delay);
      });
      t.mock.method(Service, "getLogoDataMTime", () => { ++lookups; return gate.promise; });
      const previous = _.service;
      const service = { networkId, serviceId: 101, logoId: 1 };
      _.service = { get: () => service, findByNetworkId: () => [service] };
      t.after(() => { _.service = previous; });
      const [f] = filter(networkId);
      let preparing;
      let duplicate;
      try {
        if (networkId === 0xFFFE) {
          await write(f, [pat([[0, 0x10], [101, 0x1F0], [97, 0x1F2], [98, 0x1F4]]),
            nit(networkId, [[TSID, [[101, 0x01], [97, 0xA4]]]])]);
        }
        // EITによるロゴ待機開始と同じ処理を、ファイルのmtime照会で止めます。
        f._epg = { end() {} };
        preparing = f._standbyLogoData();
        assert.strictEqual(lookups, 1);
        if (networkId === 0xFFFE) {
          // NITのESS検出と同じ処理で、待機中に追加のESSを通知します。
          f._detectEss([{ service_id: 98, service_type: 0xA4 }]);
        } else {
          duplicate = f._standbyLogoData();
        }
        assert.strictEqual(lookups, 1, "照会完了前の後発要求は並行して照会しません");
        gate.resolve(0);
        await preparing;
        await tick();
        assert.strictEqual(timers, 1);
        assert.strictEqual(f._parser.listenerCount(networkId === 0xFFFE ? "dsmcc" : "cdt"), 1);
        if (networkId === 0xFFFE) { assert.ok(f._parsePids.has(0x1F4), "待機中に検出したESSも解析対象に含めます"); }
        f.close();
        t.mock.timers.tick(30 * 60 * 1000);
        assert.strictEqual(fired, 0, "close後にロゴ待機タイマーを残しません");
      } finally {
        gate.resolve(0);
        await preparing;
        await duplicate;
        await tick();
        f.close();
      }
    });
  }

  it("ロゴ準備の照会中にcloseした場合はlistenerとtimerを登録しない", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const Service = require("../lib/Mirakurun/Service").default;
    const gate = Promise.withResolvers();
    t.mock.method(Service, "getLogoDataMTime", () => gate.promise);
    const previous = _.service;
    const service = { networkId: 0x7FE0, serviceId: 101, logoId: 1 };
    _.service = { get: () => service, findByNetworkId: () => [service] };
    t.after(() => { _.service = previous; });
    const [f] = filter(service.networkId);
    const parser = f._parser;
    const preparing = f._standbyLogoData();
    f.close();
    gate.resolve(0);
    await preparing;
    assert.strictEqual(parser.listenerCount("cdt"), 0);
    assert.strictEqual(f._logoDataTimer, undefined);
  });

  it("ロゴ準備の照会が拒否されたあとも次の要求で待機できる", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const Service = require("../lib/Mirakurun/Service").default;
    const expected = new Error("fixture logo metadata failure");
    let lookups = 0;
    t.mock.method(Service, "getLogoDataMTime", async () => { if (++lookups === 1) { throw expected; } return 0; });
    const previous = _.service;
    const service = { networkId: 0x7FE0, serviceId: 101, logoId: 1 };
    _.service = { get: () => service, findByNetworkId: () => [service] };
    t.after(() => { _.service = previous; });
    const [f] = filter(service.networkId);
    try {
      await assert.rejects(f._standbyLogoData(), error => error === expected);
      assert.strictEqual(f._parser.listenerCount("cdt"), 0);
      await f._standbyLogoData();
      assert.strictEqual(lookups, 2);
      assert.strictEqual(f._parser.listenerCount("cdt"), 1);
      assert.ok(f._logoDataTimer);
    } finally { f.close(); }
  });

  it("ロゴ準備で更新不要なら印を解除し、次の要求で期限切れを確認できる", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const Service = require("../lib/Mirakurun/Service").default;
    let lookups = 0;
    t.mock.method(Service, "getLogoDataMTime", async () => ++lookups === 1 ? Date.now() : 0);
    const previous = _.service;
    const service = { networkId: 0x7FE0, serviceId: 101, logoId: 1 };
    _.service = { get: () => service, findByNetworkId: () => [service] };
    t.after(() => { _.service = previous; });
    const [f] = filter(service.networkId);
    try {
      await f._standbyLogoData();
      assert.strictEqual(f._parser.listenerCount("cdt"), 0);
      assert.strictEqual(f._logoDataTimer, undefined);
      await f._standbyLogoData();
      assert.strictEqual(lookups, 2);
      assert.strictEqual(f._parser.listenerCount("cdt"), 1);
      assert.ok(f._logoDataTimer);
    } finally { f.close(); }
  });

  for (const networkId of [4, 0xFFFE]) {
    it(`ESSのPMTを解析後にPATのPID変更へ追従し、待機終了後は再開しない (networkId=${networkId})`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const Service = require("../lib/Mirakurun/Service").default;
      const serviceId = networkId === 4 ? 929 : 97;
      const service = { networkId, serviceId: 101, logoId: 1, name: "TV" };
      t.mock.method(Service, "getLogoDataMTime", async () => 0);
      const previous = _.service;
      _.service = { get: () => service, findByNetworkId: () => [service] };
      t.after(() => { _.service = previous; });
      const [f] = filter(networkId);
      const pmt = (pid, esPid) => sectionPacket(pid, 0x02, serviceId, [
        ...u16(0xE000 | esPid), ...u16(0xF000),
        0x0D, ...u16(0xE000 | esPid), ...u16(0xF003), 0x52, 1, 0x79
      ]);
      try {
        await write(f, [pat([[0, 0x10], [101, 0x1F0], [serviceId, 0x1F2]])]);
        if (networkId !== 4) { await write(f, [nit(networkId, [[TSID, [[101, 0x01], [serviceId, 0xA4]]]])]); }
        await f._standbyLogoData();
        assert.ok(f._parsePids.has(0x1F2));
        await write(f, [pmt(0x1F2, 0x771)]);
        assert.ok(f._essEsPids.has(0x771));
        assert.strictEqual(f._parsePids.has(0x1F2), false);
        await write(f, [pat([[0, 0x10], [101, 0x1F0], [serviceId, 0x1F4]]), pmt(0x1F2, 0x773), pmt(0x1F4, 0x772)]);
        assert.ok(f._essEsPids.has(0x772), "更新後のPMTから新しいロゴ用PIDを読み込みます");
        assert.strictEqual(f._essEsPids.has(0x773), false, "旧PMTは再解析しません");
        assert.strictEqual(f._parsePids.has(0x1F2), false);
        assert.strictEqual(f._parsePids.has(0x1F4), false);
        t.mock.timers.tick(30 * 60 * 1000);
        await write(f, [pat([[0, 0x10], [101, 0x1F0], [serviceId, 0x1F6]]), pmt(0x1F6, 0x774)]);
        assert.strictEqual(f._parsePids.has(0x1F6), false);
        assert.strictEqual(f._essEsPids.has(0x774), false);
      } finally { f.close(); }
    });
  }

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

// ロゴデータのモジュール (ARIB TR-B15 第一部 第一編 表 5-6): [logoId, [[networkId, tsid, serviceId], ...], data]
function logoModule(logos) {
  return Buffer.from([
    0x05, ...u16(logos.length),
    ...logos.flatMap(([logoId, services, data]) => [
      ...u16(0xFE00 | logoId), services.length, ...services.flat().flatMap(u16), ...u16(data.length), ...data
    ])
  ]);
}

// DSM-CC は aribts の解析結果を直接渡す (DDB は複数のパケットにまたがるため)
function dii(downloadId, moduleSize, blockSize, name = "LOGO-05") {
  const modules = [{ moduleId: 3, moduleVersion: 0, moduleSize, moduleInfo: [{ descriptor_tag: 0x02, text_char: Buffer.from(name) }] }];
  return { table_id: 0x3B, message: { downloadId, blockSize, modules } };
}

function ddb(downloadId, blockNumber, blockDataByte) {
  return { table_id: 0x3C, message: { downloadId, moduleId: 3, moduleVersion: 0, blockNumber, blockDataByte } };
}

function blocks(data, blockSize) {
  const list = [];
  for (let i = 0; i < data.length; i += blockSize) {
    list.push(data.subarray(i, i + blockSize));
  }
  return list;
}

describe("[tsfilter-ess.spec] TSFilter.ts: logo data in the ESS", () => {
  const { TsLogo } = require("@chinachu/aribts");
  let Service;
  let saved;
  let services;
  before(() => {
    Service = require("../lib/Mirakurun/Service").default;
    Service.saveLogoData = (networkId, logoId, data) => saved.push([networkId, logoId, data]);
    _.service = {
      get: (networkId, serviceId) => services.find(s => s.networkId === networkId && s.serviceId === serviceId) || null,
      findByNetworkId: () => []
    };
  });
  beforeEach(() => {
    saved = [];
    services = [{ networkId: 4, serviceId: 101, logoId: -1 }];
  });

  it("assembles the module after all the blocks are received regardless of the order and duplicates", () => {
    const data = [...Buffer.from("NHK BS LOGO DATA")];
    const module = logoModule([[0x10, [[4, 16625, 101]], data]]);
    const [f] = filter(4);

    f._onDSMCC(0x771, dii(1, module.length, 8));
    // 繰り返し送られるカルーセルで、重複したブロックを受け取り、1 つ目のブロックを取りこぼす
    const list = blocks(module, 8);
    for (const blockNumber of [0, 0, ...list.keys()].filter(n => n !== 1)) {
      f._onDSMCC(0x771, ddb(1, blockNumber, list[blockNumber]));
    }
    assert.deepStrictEqual(saved, []);

    // 次の周期で取りこぼしたブロックを受け取ると完成する
    f._onDSMCC(0x771, ddb(1, 1, list[1]));
    f.close();

    assert.deepStrictEqual(saved, [[4, 0x10, TsLogo.decode(Buffer.from(data))]]);
    assert.strictEqual(services[0].logoId, 0x10);
  });

  it("retains multiple logo modules of one DII and completes them independently", () => {
    const first = logoModule([[0x10, [[4, 16625, 101]], [...Buffer.from("FIRST")]]]);
    const second = logoModule([[0x11, [[4, 16625, 102]], [...Buffer.from("SECOND")]]]);
    services.push({ networkId: 4, serviceId: 102, logoId: -1 });
    const [f] = filter(4);
    try {
      const info = dii(1, first.length, 8);
      info.message.modules.push({ ...info.message.modules[0], moduleId: 4, moduleSize: second.length });
      f._onDSMCC(0x771, info);
      assert.strictEqual(f._dlDataMap.size, 2);
      // DIIの繰り返しで、受信済みのブロックは初期化しない。
      f._onDSMCC(0x771, ddb(1, 0, blocks(first, 8)[0]));
      f._onDSMCC(0x771, info);
      const secondBlocks = blocks(second, 8);
      for (let i = 0; i < secondBlocks.length; ++i) {
        const block = ddb(1, i, secondBlocks[i]);
        block.message.moduleId = 4;
        f._onDSMCC(0x771, block);
      }
      for (const [i, block] of blocks(first, 8).entries()) {
        if (i !== 0) { f._onDSMCC(0x771, ddb(1, i, block)); }
      }
      assert.deepStrictEqual(saved.map(([networkId, logoId]) => [networkId, logoId]), [[4, 0x11], [4, 0x10]]);
      assert.deepStrictEqual(services.map(service => service.logoId), [0x10, 0x11]);
    } finally { f.close(); }
    assert.strictEqual(f._dlDataMap.size, 0);
  });


  it("完了したDSMCCモジュールは新しい受信枠を妨げず、未完了のデータと直近の重複抑止を保持する", () => {
    const [f] = filter(4);
    const module = logoModule([[0x10, [[4, 16625, 101]], [...Buffer.from("LOGO")]]]);
    const list = blocks(module, 8);
    try {
      f._onDSMCC(0x771, dii(999, module.length, 8));
      f._onDSMCC(0x771, ddb(999, 0, list[0]));
      const partial = f._dlDataMap.get("999:3");
      for (let id = 1; id <= 70; ++id) {
        const info = dii(id, module.length, 8);
        f._onDSMCC(0x771, info);
        for (const [index, block] of list.entries()) { f._onDSMCC(0x771, ddb(id, index, block)); }
        assert.strictEqual(saved.length, id, `downloadId=${id}のロゴを保存します`);
        assert.ok(f._dlDataMap.size <= 64);
        const completed = f._dlDataMap.get(`${id}:3`);
        assert.ok(completed);
        assert.strictEqual(completed.data, undefined);
        assert.strictEqual(completed.loadedBlocks.size, 0, "完了したブロック番号も解放します");
        // 同じDII/DDBを再受信しても再ダウンロードしません。
        f._onDSMCC(0x771, info);
        for (const [index, block] of list.entries()) { f._onDSMCC(0x771, ddb(id, index, block)); }
        assert.strictEqual(saved.length, id);
        assert.strictEqual(f._dlDataMap.get("999:3"), partial);
        assert.strictEqual(partial.loadedBlocks.size, 1);
      }
      for (let index = 1; index < list.length; ++index) { f._onDSMCC(0x771, ddb(999, index, list[index])); }
      assert.strictEqual(saved.length, 71);
      // 同じdownload/moduleの新しいバージョンは受け取ります。
      const updated = dii(70, module.length, 8); updated.message.modules[0].moduleVersion = 1;
      f._onDSMCC(0x771, updated);
      for (const [index, block] of list.entries()) {
        const packet = ddb(70, index, block); packet.message.moduleVersion = 1;
        f._onDSMCC(0x771, packet);
      }
      assert.strictEqual(saved.length, 72);
      assert.strictEqual(f._dlDataMap.get("70:3").moduleVersion, 1);
    } finally { f.close(); }
    assert.strictEqual(f._dlDataMap.size, 0);
  });

  it("bounds bytes and module count across multiple modules in one DII", () => {
    const [large] = filter(4);
    const [many] = filter(4);
    try {
      const info = dii(1, 6 * 1024 * 1024, 4066);
      info.message.modules = Array.from({ length: 3 }, (_, moduleId) => ({ ...info.message.modules[0], moduleId }));
      large._onDSMCC(0x771, info);
      assert.strictEqual(large._dlDataMap.size, 2);
      assert.strictEqual([...large._dlDataMap.values()].reduce((bytes, item) => bytes + item.data.length, 0), 12 * 1024 * 1024);
      const small = dii(2, 8, 8);
      small.message.modules = Array.from({ length: 65 }, (_, moduleId) => ({ ...small.message.modules[0], moduleId }));
      many._onDSMCC(0x771, small);
      assert.strictEqual(many._dlDataMap.size, 64);
    } finally { large.close(); many.close(); }
    assert.strictEqual(large._dlDataMap.size, 0);
    assert.strictEqual(many._dlDataMap.size, 0);
  });

  it("ignores the blocks out of the module or with the wrong size", () => {
    const module = logoModule([[0x10, [[4, 16625, 101]], [...Buffer.from("LOGO")]]]);
    const list = blocks(module, 8);
    const [f] = filter(4);

    f._onDSMCC(0x771, dii(1, module.length, 8));
    f._onDSMCC(0x771, ddb(1, list.length, list[0]));
    f._onDSMCC(0x771, ddb(1, 0, list[0].subarray(1)));
    f._onDSMCC(0x771, ddb(1, list.length - 1, Buffer.alloc(8)));
    for (const [blockNumber, block] of list.slice(0, -1).entries()) {
      f._onDSMCC(0x771, ddb(1, blockNumber, block));
    }
    assert.deepStrictEqual(saved, []);

    f._onDSMCC(0x771, ddb(1, list.length - 1, list[list.length - 1]));
    f.close();

    assert.deepStrictEqual(saved.map(([networkId, logoId]) => [networkId, logoId]), [[4, 0x10]]);
  });

  it("refers all the services sharing the logo to it and saves the logo data once per network", () => {
    services.push({ networkId: 4, serviceId: 102, logoId: -1 }, { networkId: 6, serviceId: 55, logoId: -1 });
    const data = [...Buffer.from("SHARED")];
    // 登録されていないサービス (103) は飛ばす
    const module = logoModule([[0x10, [[4, 16625, 103], [4, 16625, 101], [4, 16625, 102], [6, 24608, 55]], data]]);
    const [f] = filter(4);

    f._onDSMCC(0x771, dii(1, module.length, 4066));
    f._onDSMCC(0x771, ddb(1, 0, module));
    f.close();

    assert.deepStrictEqual(services.map(s => s.logoId), [0x10, 0x10, 0x10]);
    assert.deepStrictEqual(saved.map(([networkId, logoId]) => [networkId, logoId]), [[4, 0x10], [6, 0x10]]);
  });
});
