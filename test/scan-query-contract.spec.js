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
const { it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const _ = require("../lib/Mirakurun/_").default;
const config = require("../lib/Mirakurun/config");
const api = require("../lib/Mirakurun/api");
const scanPath = require.resolve("../lib/Mirakurun/api/config/channels/scan");
let scan;
beforeEach(() => { delete require.cache[scanPath]; scan = require(scanPath); });
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, setHeader() {}, write(body) { this.body = (this.body ?? "") + body; }, json(body) { this.body = JSON.stringify(body); }, end(body) { if (body !== undefined) { this.body = body; } } }; }
const queries = [
    { type: "BS", route: "TER" }, { type: "CS", route: "TER" },
    { route: "CATV", channels: ["C13", "C14"] },
    { route: "CATV", source: "preset", channels: ["C13"] },
    { route: "CATV", source: "dvbConf", channels: ["C13"] },
    { route: "CATV", source: "format", minCh: 13, maxCh: 13, channelNameFormat: "C{ch}", channels: ["C13"] },
    { type: "GR", channels: ["13"] }
];
for (const query of queries) {
    it(`[scan-query-contract.spec] incompatible route or unused channels is rejected before IO ${JSON.stringify(query)}`, async t => {
        let announceIO, releaseIO;
        const enteredIO = new Promise(resolve => { announceIO = resolve; });
        const readGate = new Promise(resolve => { releaseIO = resolve; });
        const loaded = t.mock.method(config, "loadChannels", async () => { announceIO(); return readGate; });
        const names = t.mock.fn(async () => []);
        const previous = { tuner: _.tuner, channel: _.channel, config: _.config, configIntegrity: _.configIntegrity };
        _.tuner = { getScanAttempts: () => [{ type: "GR", devices: [{}] }], getDvbChannelNames: names, typeExists: () => true,
            scanChannel: async () => [{ format: "ts", services: [] }] };
        _.channel = { getStreams: () => [], get: () => null };
        _.config = { server: {}, channels: [] }; _.configIntegrity = { channels: "query-contract" };
        t.after(() => Object.assign(_, previous));
        const errors = t.mock.method(api, "responseError", (res, code, reason) => { res.status(code); res.reason = reason; });
        const result = response();
        const pending = scan.put(Object.assign(new EventEmitter(), { query, socket: { destroyed: false }, setTimeout() {} }), result);
        try {
            const reachedIO = await Promise.race([enteredIO.then(() => true), pending.then(() => false)]);
            if (reachedIO) { releaseIO([]); }
            await pending;
        } finally { releaseIO([]); await pending; }
        assert.equal(result.statusCode, 400);
        assert.match(result.reason, query.channels === undefined ? /route/ : /channels.*source=list/);
        assert.equal(loaded.mock.callCount(), 0);
        assert.equal(names.mock.callCount(), 0);
        assert.equal(errors.mock.callCount(), 1);
    });
}
it("[scan-query-contract.spec] routeの既定補完で明示TERを失わない", () => {
    const route = scan.put.apiDoc.parameters.find(parameter => parameter.name === "route");
    assert.equal(route.default, undefined);
});
