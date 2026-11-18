/*
   Copyright 2026 The Mirakurun Developers.

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
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0 }
} } };
const _ = require("../lib/Mirakurun/_").default;
const log = require("../lib/Mirakurun/log");
const TSFilter = require("../lib/Mirakurun/TSFilter").default;
const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;

for (const [name, Filter] of [["TSFilter", TSFilter], ["TLVFilter", TLVFilter]]) {
    for (const endOutput of [false, true]) {
        it(`${name}.close(${endOutput})は出力先所有者の購読を保持する`, t => {
            _.config = { server: {} };
            for (const level of ["info", "warn", "error", "debug"]) { t.mock.method(log, level, () => {}); }
            const written = [];
            const output = new Writable({ write(chunk, _encoding, done) { written.push(Buffer.from(chunk)); done(); } });
            t.after(() => output.destroy());
            const owner = () => {};
            for (const event of ["error", "finish", "close", "drain"]) { output.on(event, owner); }
            const filter = new Filter({ output, ...(name === "TSFilter" && { rawTsmf: true }) });
            if (!endOutput) {
                const packet = name === "TSFilter" ? Buffer.alloc(188) : Buffer.from([0x7F, 0xFF, 0, 0]);
                if (name === "TSFilter") { packet[0] = 0x47; packet[1] = 0x1F; packet[2] = 0xFF; }
                filter.write(Buffer.concat([packet, packet]), true);
            }
            filter.close(endOutput);
            assert.equal(output.writableEnded, endOutput);
            assert.equal(filter.closed, true);
            assert.equal(written.length, 0);
            for (const event of ["error", "finish", "close", "drain"]) { assert.deepEqual(output.listeners(event), [owner]); }
        });
    }
}
