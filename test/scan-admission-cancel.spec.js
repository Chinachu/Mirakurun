/*
   Copyright 2026 kanreisa

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
const _ = require("../lib/Mirakurun/_").default;
const config = require("../lib/Mirakurun/config");
const api = require("../lib/Mirakurun/api");
const scan = require("../lib/Mirakurun/api/config/channels/scan");
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, setHeader() {}, json(value) { this.value = value; return this; }, end(value) { if (value !== undefined) { this.value = JSON.parse(value); } this.ended = true; } }; }
for (const failRead of [false, true]) {
    it(`[scan-admission-cancel.spec] dvbConf読込中のDELETEは受付前取消しで終わる (failure=${failRead})`, { timeout: 5000 }, async t => {
        const entered = deferred(), gate = deferred();
        const previous = _.tuner;
        const errors = t.mock.method(api, "responseError", (res, code) => { res.status(code); res.end(); });
        t.mock.method(config, "loadChannels", async () => []);
        t.mock.method(config, "mergeAndSaveChannels", async merge => merge([]));
        let acquired = 0;
        _.tuner = {
            getScanAttempts: () => [{ type: "GR", devices: [{}] }],
            getDvbChannelNames: async () => { entered.resolve(); await gate.promise; if (failRead) { throw new Error("read failed"); } return ["C13"]; },
            scanChannel: async () => { acquired++; return []; }
        };
        const result = response();
        const running = scan.put({ query: { route: "CATV", source: "dvbConf", async: true } }, result);
        try {
            await entered.promise;
            const stop = response(); await scan.del({}, stop);
            assert.equal(stop.statusCode, 206);
            gate.resolve(); await running;
            assert.equal(result.statusCode, 204);
            assert.equal(result.ended, true);
            assert.equal(acquired, 0);
            assert.equal(errors.mock.callCount(), 0);
            // responseJSONはcallbackで本文を終えるので、operationの返却だけではなくendまで待つ。
            const current = await new Promise(resolve => scan.get({}, { setHeader() {}, status() {}, end(body) { resolve(JSON.parse(body)); } }));
            assert.equal(current.isScanning, false);
        } finally {
            gate.resolve(); await running;
            // 退行時に誤って開始した処理もfixtureの設定I/Oだけで終了させてから元へ戻す。
            await new Promise(resolve => setImmediate(resolve));
            _.tuner = previous;
        }
    });
}
