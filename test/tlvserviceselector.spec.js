const { describe, it, before } = require("node:test");
const assert = require("assert");

let TLVServiceSelector;
let createMMTTLVReader;

// TLV packet with the compressed IP header (CID_header_type 0x61) and MMTP packet
function mmtpPacket(packetId, payloadType, payload) {
  const mmtp = Buffer.alloc(12);
  mmtp[0] = 0x40;
  mmtp[1] = payloadType;
  mmtp.writeUInt16BE(packetId, 2);
  const body = Buffer.concat([Buffer.from([0x00, 0x01, 0x61]), mmtp, payload]);
  const header = Buffer.from([0x7F, 0x03, 0, 0]);
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
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

  it("drops the MPT and the assets of the other services, keeping the shared ones and the others", () => {
    const data = Buffer.concat([0x9000, 0x0100, 0x0110, 0x9001, 0x0101, 0x0111, 0x0200, 0x8000, 0x0300]
      .map(id => mmtpPacket(id, 0x00, Buffer.alloc(10))));

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

  it("passes the packets which are not MMTP", () => {
    const control = Buffer.from([0x7F, 0xFE, 0x00, 0x02, 0x00, 0x00]);
    const nullPacket = Buffer.from([0x7F, 0xFF, 0x00, 0x01, 0xFF]);

    const out = selector().push(Buffer.concat([control, nullPacket]));

    assert.deepStrictEqual(out, Buffer.concat([control, nullPacket]));
  });
});
