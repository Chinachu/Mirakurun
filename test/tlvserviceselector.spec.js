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

let TLVServiceSelector;
let createMMTTLVReader;

// the length of the compressed header of CID_header_type (ARIB STD-B32 Part 3, 3.7)
const COMPRESSED_HEADER_SIZE = { 0x20: 20, 0x21: 2, 0x60: 42, 0x61: 0 };

// TLV packet with the compressed IP header (CID_header_type 0x61 by default) and MMTP packet
function mmtpPacket(packetId, payloadType, payload, headerType = 0x61) {
  const mmtp = Buffer.alloc(12);
  mmtp[0] = 0x40;
  mmtp[1] = payloadType;
  mmtp.writeUInt16BE(packetId, 2);
  // the compressed header is filled with the packet ID dropped, not to be read as MMTP
  const compressed = Buffer.alloc(COMPRESSED_HEADER_SIZE[headerType]);
  for (let i = 0; i + 1 < compressed.length; i += 2) {
    compressed.writeUInt16BE(0x0100, i);
  }
  const body = Buffer.concat([Buffer.from([0x00, 0x01, headerType]), compressed, mmtp, payload]);
  const header = Buffer.from([0x7F, 0x03, 0, 0]);
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function udpPacket(ipVersion, payload) {
  const ipHeaderSize = ipVersion === 6 ? 40 : 20;
  const header = Buffer.alloc(4 + ipHeaderSize + 8);
  header.set([0x7F, ipVersion === 6 ? 0x02 : 0x01]);
  header.writeUInt16BE(ipHeaderSize + 8 + payload.length, 2);
  if (ipVersion === 6) {
    header[4] = 0x60;
    header.writeUInt16BE(8 + payload.length, 8);
    header[10] = 17;
  } else {
    header[4] = 0x45;
    header.writeUInt16BE(ipHeaderSize + 8 + payload.length, 6);
    header[13] = 17;
  }
  const udp = 4 + ipHeaderSize;
  header.writeUInt16BE(5000, udp + 2);
  header.writeUInt16BE(8 + payload.length, udp + 4);
  return Buffer.concat([header, payload]);
}

function plt(packages) {
  const entries = packages.map(([serviceId, mptPacketId]) => {
    const entry = Buffer.alloc(6);
    entry[0] = 2;
    entry.writeUInt16BE(serviceId, 1);
    entry[3] = 0x00;
    entry.writeUInt16BE(mptPacketId, 4);
    return entry;
  });
  // num_of_package, the packages, num_of_ip_delivery
  const body = Buffer.concat([Buffer.from([packages.length]), ...entries, Buffer.from([0])]);
  const header = Buffer.from([0x80, 0, 0, 0]);
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

// PA message in the signalling message payload (not fragmented, not aggregated)
function paPacket(table) {
  const extension = Buffer.concat([Buffer.from([1, table[0], table[1], table[2], table[3]]), table]);
  const message = Buffer.alloc(7);
  message.writeUInt16BE(0x0000, 0);
  message.writeUInt32BE(extension.length, 3);
  return mmtpPacket(0x0000, 0x02, Buffer.concat([Buffer.from([0x00, 0x00]), message, extension]));
}

function mpt(serviceId, assetPacketIds) {
  return {
    mmtPackageId: Uint8Array.from([serviceId >> 8, serviceId & 0xFF]),
    assets: assetPacketIds.map(packetId => ({ locations: [{ locationType: "sameDataflow", packetId }] }))
  };
}

function packetIds(data) {
  const ids = [];
  for (let pos = 0; pos < data.length; pos += 4 + data.readUInt16BE(pos + 2)) {
    assert.strictEqual(data[pos], 0x7F);
    ids.push(data.readUInt16BE(pos + 4 + 3 + 2));
  }
  return ids;
}

describe("[tlvserviceselector.spec] TLVServiceSelector", () => {
  before(async () => {
    TLVServiceSelector = require("../lib/Mirakurun/TLVServiceSelector").default;
    ({ createMMTTLVReader } = await import("arib-mmt-tlv-ts"));
  });

  function selector() {
    const s = new TLVServiceSelector(0x0102);
    s.onPLT({ packages: [
      { mmtPackageId: Uint8Array.from([0x01, 0x01]), locationInfo: { locationType: "sameDataflow", packetId: 0x9000 } },
      { mmtPackageId: Uint8Array.from([0x01, 0x02]), locationInfo: { locationType: "sameDataflow", packetId: 0x9001 } }
    ] });
    s.onMPT(mpt(0x0101, [0x0100, 0x0110, 0x0200]));
    s.onMPT(mpt(0x0102, [0x0101, 0x0111, 0x0200]));
    return s;
  }

  it("drops the MPT and media of the other services, keeping shared assets and unknown signalling", () => {
    const data = Buffer.concat([0x9000, 0x0100, 0x0110, 0x9001, 0x0101, 0x0111, 0x0200, 0x8000, 0x0300]
      .map(id => mmtpPacket(id, id === 0x8000 || id === 0x0300 ? 0x02 : 0x00, Buffer.alloc(10))));

    const out = selector().push(data);

    assert.deepStrictEqual(packetIds(out), [0x9001, 0x0101, 0x0111, 0x0200, 0x8000, 0x0300]);
  });

  it("rewrites PLT to list the service selected only", () => {
    const out = selector().push(paPacket(plt([[0x0101, 0x9000], [0x0102, 0x9001]])));

    assert.deepStrictEqual(out, paPacket(plt([[0x0102, 0x9001]])));

    // arib-mmt-tlv-ts reads the PLT rewritten
    const reader = createMMTTLVReader();
    const tables = [];
    reader.addEventListener("plt", e => tables.push(e.table));
    reader.push(Uint8Array.from(out));
    assert.strictEqual(tables.length, 1);
    assert.deepStrictEqual(tables[0].packages.map(pkg => [...pkg.mmtPackageId]), [[0x01, 0x02]]);
    assert.strictEqual(tables[0].packages[0].locationInfo.packetId, 0x9001);
  });

  it("outputs the complete TLV packets only, from the start of a packet", () => {
    const packets = [0x9001, 0x9000, 0x0101].map(id => mmtpPacket(id, 0x00, Buffer.alloc(30)));
    const data = Buffer.concat([Buffer.from([0x11, 0x7F, 0x22]), ...packets]);
    const s = selector();

    const out = Buffer.concat([s.push(data.subarray(0, 50)), s.push(data.subarray(50))]);

    assert.deepStrictEqual(out, Buffer.concat([packets[0], packets[2]]));
  });

  it("reads MMTP after the compressed header of each CID_header_type", () => {
    for (const headerType of [0x20, 0x21, 0x60, 0x61]) {
      const kept = mmtpPacket(0x0101, 0x00, Buffer.alloc(10), headerType);
      const dropped = mmtpPacket(0x0100, 0x00, Buffer.alloc(10), headerType);

      const out = selector().push(Buffer.concat([kept, dropped]));

      assert.deepStrictEqual(out, kept, `CID_header_type 0x${headerType.toString(16)}`);
    }
  });

  it("passes the packets which are not MMTP", () => {
    const control = Buffer.from([0x7F, 0xFE, 0x00, 0x02, 0x00, 0x00]);
    const nullPacket = Buffer.from([0x7F, 0xFF, 0x00, 0x01, 0xFF]);

    const out = selector().push(Buffer.concat([control, nullPacket]));

    assert.deepStrictEqual(out, Buffer.concat([control, nullPacket]));
  });
  for (const ipVersion of [4, 6]) {
    it(`keeps unclassified IPv${ipVersion} UDP while dropping unknown compressed MPU`, () => {
      const s = selector();
      assert.strictEqual(s.ready, true);
      const unclassified = [0x00, 0x12, 0x40].map(flags => {
        const payload = Buffer.alloc(12);
        payload[0] = flags;
        payload.writeUInt16BE(0x0999, 2);
        return udpPacket(ipVersion, payload);
      });
      const unknownMedia = mmtpPacket(0x0999, 0, Buffer.alloc(10));
      const unknownData = mmtpPacket(0x0999, 1, Buffer.alloc(10));
      const unknownSI = mmtpPacket(0x8000, 2, Buffer.from([0, 0]));
      const selectedMedia = mmtpPacket(0x0101, 0, Buffer.alloc(10));
      const out = s.push(Buffer.concat([...unclassified, unknownMedia, unknownData, unknownSI, selectedMedia]));
      assert.deepStrictEqual(out, Buffer.concat([...unclassified, unknownData, unknownSI, selectedMedia]));
    });

    it(`selects known MMTP assets carried in IPv${ipVersion} UDP`, () => {
      const selected = udpPacket(ipVersion, mmtpPacket(0x0101, 0, Buffer.alloc(10)).subarray(7));
      const excluded = udpPacket(ipVersion, mmtpPacket(0x0100, 0, Buffer.alloc(10)).subarray(7));
      assert.deepStrictEqual(selector().push(Buffer.concat([excluded, selected])), selected);
    });
  }

  for (const carrier of ["compressed", "ipv6"]) {
    it(`[tlvserviceselector.spec] 選択MPTの別IPv6フローにある資産も保持する (carrier=${carrier})`, () => {
      const s = selector();
      const external = { locationType: "ipv6Dataflow", ipv6SourceAddress: new Uint8Array(16),
        ipv6DestAddress: new Uint8Array(16), destPort: 5000, packetId: 0x0100 };
      const table = mpt(0x0102, [0x0101]);
      table.assets.push({ locations: [external] });
      s.onMPT(table);
      const media = mmtpPacket(0x0100, 0, Buffer.alloc(20));
      let selected = media;
      if (carrier === "ipv6") {
        const header = Buffer.alloc(4 + 40 + 8);
        header.set([0x7F, 0x02]);
        header.writeUInt16BE(40 + 8 + media.length - 7, 2);
        header[4] = 0x60;
        header.writeUInt16BE(8 + media.length - 7, 8);
        header[10] = 17;
        header.writeUInt16BE(5000, 46);
        header.writeUInt16BE(8 + media.length - 7, 48);
        selected = Buffer.concat([header, media.subarray(7)]);
      }
      const kept = mmtpPacket(0x0101, 0, Buffer.alloc(20));
      const unrelated = mmtpPacket(0x0999, 0, Buffer.alloc(20));
      assert.deepStrictEqual(s.push(Buffer.concat([selected, unrelated, kept])), Buffer.concat([selected, kept]));
      // 選択MPTから別フローの参照が消えた後は、その旧資産を保持し続けない。
      s.onMPT(mpt(0x0102, [0x0101]));
      assert.deepStrictEqual(s.push(Buffer.concat([media, kept])), kept);
    });
  }
  it("[tlvserviceselector.spec] 他サービスの別フロー参照だけを根拠に同じpacket_idの制御情報を除外しない", () => {
    const s = selector();
    const table = mpt(0x0101, [0x0100]);
    table.assets.push({ locations: [{ locationType: "ipv6Dataflow", ipv6SourceAddress: new Uint8Array(16),
      ipv6DestAddress: new Uint8Array(16), destPort: 5000, packetId: 0x8000 }] });
    s.onMPT(table);
    const signalling = mmtpPacket(0x8000, 2, Buffer.from([0, 0]));
    assert.deepStrictEqual(s.push(signalling), signalling);
  });
  it("[tlvserviceselector.spec] 依存readerが解析したIPv6別フローのMPTで資産を保持する", () => {
    const s = selector();
    const location = Buffer.alloc(37);
    location[0] = 2;
    location.writeUInt16BE(5000, 33);
    location.writeUInt16BE(0x0300, 35);
    const body = Buffer.concat([Buffer.from([0xFF, 2, 1, 2, 0, 0, 1,
      0, 0, 0, 0, 0, 2, 0, 0, 0x68, 0x65, 0x76, 0x31, 0xFE, 1]), location, Buffer.from([0, 0])]);
    const table = Buffer.from([0x20, 0, 0, 0]);
    table.writeUInt16BE(body.length, 2);
    const reader = createMMTTLVReader();
    let notified = 0;
    reader.addEventListener("mpt", event => {
      ++notified;
      assert.strictEqual(event.table.assets[0].locations[0].locationType, "ipv6Dataflow");
      s.onMPT(event.table);
    });
    reader.push(paPacket(Buffer.concat([table, body])));
    assert.strictEqual(notified, 1);
    const media = mmtpPacket(0x0300, 0, Buffer.alloc(20));
    const other = mmtpPacket(0x0400, 0, Buffer.alloc(20));
    assert.deepStrictEqual(s.push(Buffer.concat([other, media])), media);
    reader.close();
  });

});

it("[tlvserviceselector.spec] 他サービスのMPT到着前も、選択済みMPTにない映像・音声は流さない", () => {
  const TLVServiceSelector = require("../lib/Mirakurun/TLVServiceSelector").default;
  const s = new TLVServiceSelector(0x0102);
  s.onPLT({ packages: [
    { mmtPackageId: Uint8Array.from([0x01, 0x01]), locationInfo: { locationType: "sameDataflow", packetId: 0x9000 } },
    { mmtPackageId: Uint8Array.from([0x01, 0x02]), locationInfo: { locationType: "sameDataflow", packetId: 0x9001 } }
  ] });
  s.onMPT(mpt(0x0102, [0x0101, 0x0111, 0x0200]));
  const media = [0x0100, 0x0101, 0x0110, 0x0111, 0x0200].map(id => mmtpPacket(id, 0, Buffer.alloc(10)));
  const signalling = [0x8000, 0x8004, 0x9001].map(id => mmtpPacket(id, 2, Buffer.from([0, 0])));
  assert.deepStrictEqual(packetIds(s.push(Buffer.concat([...media, ...signalling]))), [0x0101, 0x0111, 0x0200, 0x8000, 0x8004, 0x9001]);
  // 選択MPTの新版で追加された資産と共有資産を直ちに通します。
  s.onMPT(mpt(0x0102, [0x0101, 0x0111, 0x0200, 0x0100]));
  assert.deepStrictEqual(packetIds(s.push(Buffer.concat(media))), [0x0100, 0x0101, 0x0111, 0x0200]);
});
