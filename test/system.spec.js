const { describe, it, before } = require("node:test");
const assert = require("assert");

const _ = require("../lib/Mirakurun/_").default;
let system;

describe("[system.spec] system.ts: isPermittedIPAddress()", () => {
  before(() => {
    _.config = { server: { allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: ["fc00::/7"] } };
    system = require("../lib/Mirakurun/system");
  });

  it("returns the same results as before when called repeatedly", () => {
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(system.isPermittedIPAddress("127.0.0.1"), true);
      assert.strictEqual(system.isPermittedIPAddress("10.0.0.1"), false);
      assert.strictEqual(system.isPermittedIPAddress("fd00::1"), true);
      assert.strictEqual(system.isPermittedIPAddress("2001:db8::1"), false);
      assert.strictEqual(system.isPermittedIPAddress("localhost"), false);
    }
  });

  it("follows changes of the allowed ranges", () => {
    assert.strictEqual(system.isPermittedIPAddress("10.0.0.1"), false);
    _.config.server.allowIPv4CidrRanges.push("10.0.0.0/8");
    assert.strictEqual(system.isPermittedIPAddress("10.0.0.1"), true);
    _.config.server = { allowIPv4CidrRanges: ["192.168.0.0/16"], allowIPv6CidrRanges: [] };
    assert.strictEqual(system.isPermittedIPAddress("10.0.0.1"), false);
    assert.strictEqual(system.isPermittedIPAddress("127.0.0.1"), false);
    assert.strictEqual(system.isPermittedIPAddress("fd00::1"), false);
  });
});
