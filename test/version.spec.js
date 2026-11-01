const { describe, it, before } = require("node:test");
const assert = require("assert");
const util = require("util");
const childProcess = require("child_process");

// system.ts が読み込み時に promisify(exec) するため、先に npm view の実行を差し替える
let calls = 0;
let next = () => Promise.resolve({ stdout: "9.9.9\n", stderr: "" });
const exec = () => {};
exec[util.promisify.custom] = command => {
  assert.strictEqual(command, "npm view mirakurun version");
  calls++;
  return next();
};
childProcess.exec = exec;

let system;

describe("[version.spec] system.ts: getLatestVersion()", () => {
  before(() => {
    system = require("../lib/Mirakurun/system");
  });

  it("does not cache a failure", async () => {
    next = () => Promise.reject(new Error("network"));
    await assert.rejects(system.getLatestVersion(), /network/);
    assert.strictEqual(calls, 1);

    next = () => Promise.resolve({ stdout: "9.9.9\n", stderr: "" });
    assert.strictEqual(await system.getLatestVersion(), "9.9.9");
    assert.strictEqual(calls, 2);
  });

  it("reuses the result instead of running npm on every call", async () => {
    const results = await Promise.all([system.getLatestVersion(), system.getLatestVersion()]);
    assert.deepStrictEqual(results, ["9.9.9", "9.9.9"]);
    assert.strictEqual(await system.getLatestVersion(), "9.9.9");
    assert.strictEqual(calls, 2);
  });
});
