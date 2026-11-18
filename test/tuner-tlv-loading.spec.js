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
const { it } = require("node:test");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

it("does not load the modules of MMT and TSMF when loading the TS tuner path", () => {
  execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    require("./lib/Mirakurun/Tuner");
    assert.equal(Object.keys(require.cache).some(file => file.includes("/arib-mmt-tlv-ts/") || file.endsWith("/TSMFTLV.js")), false);
    process.exit(0);
  `], { cwd: path.join(__dirname, ".."), timeout: 10000, stdio: "pipe" });
});
