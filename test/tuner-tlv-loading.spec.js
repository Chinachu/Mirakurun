const { it } = require("node:test");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

it("does not load MMT parsing modules when loading the TS tuner path", () => {
  execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    require("./lib/Mirakurun/Tuner");
    assert.equal(Object.keys(require.cache).some(file => file.includes("/arib-mmt-tlv-ts/")), false);
    process.exit(0);
  `], { cwd: path.join(__dirname, ".."), timeout: 10000, stdio: "pipe" });
});
