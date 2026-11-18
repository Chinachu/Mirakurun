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
const fs = require("node:fs");
const path = require("node:path");
const feature = fs.existsSync(path.join(__dirname, "../src/Mirakurun"));
const scan = require((feature ? "../lib/Mirakurun/api" : "../lib/server/api") + "/config/channels/scan");

async function httpFixture(t) {
    const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
    const shared = require(prefix + "/_").default;
    const config = require(prefix + "/config");
    t.mock.method(config, "loadChannels", async () => { throw new Error("受付前に設定を読み込みません"); });
    if (!feature) {
        const event = require(prefix + "/event-log");
        for (const level of ["error", "warn", "info", "debug"]) { t.mock.method(event, level, () => undefined); }
    }
    const previousTuner = shared.tuner;
    shared.tuner = { getScanAttempts: () => [{ type: "GR", devices: [{}] }] };
    t.after(() => { shared.tuner = previousTuner; });
    const app = require("express")();
    app.use((req, _res, next) => {
        Object.defineProperty(req, "query", { value: { ...req.query }, writable: true, configurable: true }); next();
    });
    const doc = feature ? {} : require("js-yaml").load(fs.readFileSync(path.join(__dirname, "../src/server/openapi.yml"), "utf8"));
    await require("express-openapi").initialize({ app, promiseMode: true,
        apiDoc: feature ? { swagger: "2.0", info: { title: "scan format admission", version: "1" }, basePath: "/api", paths: {} }
            : { openapi: "3.0.3", info: { title: "scan format admission", version: "1" }, servers: [{ url: "/api" }], components: doc.components, paths: {} },
        paths: [{ path: "/config/channels/scan", module: { put: scan.put } }] });
    if (!feature) { app.use(require("../lib/server/modules/request-error").handleRequestError); }
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}/api/config/channels/scan?`;
}

for (const option of [{ minSubCh: 0 }, { maxSubCh: 3 }, { useSubCh: true }, { useSubCh: false }]) {
    it(`subchのない書式の無効な指定${JSON.stringify(option)}を実HTTPで受付前に拒否する`, async t => {
        const endpoint = await httpFixture(t);
        const response = await fetch(endpoint + new URLSearchParams({ route: "CATV", source: "format", channelNameFormat: "C{ch}", minCh: 13, maxCh: 13, ...option }),
            { method: "PUT", signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 400);
        const failure = await response.json();
        assert.match(failure.reason, /subch/);
        assert.match(failure.reason, option.useSubCh === undefined ? /minSubCh|maxSubCh/ : /useSubCh/);
    });
}

for (const name of ["startSubCh", "endSubCh"]) {
    it(`生成関数もsubchのない書式の${name}を黙って無視しない`, () => {
        assert.throws(() => scan.generateScanConfig({ route: "CATV", source: "format", channelNameFormat: "C{ch}", startCh: 13, endCh: 13, [name]: 0 }), /minSubCh|maxSubCh/);
    });
}

it("subchなしの通常書式とゼロ埋めsubch書式は、従来どおり生成する", () => {
    assert.deepEqual(scan.generateScanConfig({ route: "CATV", source: "format", channelNameFormat: "C{ch}", startCh: 13, endCh: 14 }).channels, ["C13", "C14"]);
    assert.deepEqual(scan.generateScanConfig({ route: "SAT", source: "format", channelNameFormat: "BS{ch00}_{subch00}", startCh: 1, endCh: 1, startSubCh: 0, endSubCh: 1 }).channels, ["BS01_00", "BS01_01"]);
});

it("省略したuseSubChをルート形式へ自動補完せず、旧BSのサブチャンネル形式を維持する", () => {
    const definition = scan.put.apiDoc.parameters.find(item => item.name === "useSubCh");
    assert.equal(feature ? definition.default : definition.schema.default, undefined);
    assert.deepEqual(scan.generateScanConfig({ type: "BS", useSubCh: true, startCh: 1, endCh: 1, startSubCh: 0, endSubCh: 1 }).channels, ["BS01_0", "BS01_1"]);
});
