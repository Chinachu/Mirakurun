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
const express = require("express");
const { initialize } = require("express-openapi");
const feature = fs.existsSync(path.join(__dirname, "../src/Mirakurun"));
const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
const { default: Client } = require("../lib/client");
const _ = require(prefix + "/_").default;
const scan = require((feature ? "../lib/Mirakurun/api" : "../lib/server/api") + "/config/channels/scan");

async function listen(t, app) {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const client = new Client(); client.host = "127.0.0.1"; client.port = server.address().port;
    return { client, origin: `http://127.0.0.1:${server.address().port}` };
}

async function scanFixture(t) {
    const app = express();
    const received = [];
    app.use((req, _res, next) => {
        // 本番のexpress-openapiと同じく、queryをcoerce可能な値として渡す。
        Object.defineProperty(req, "query", { value: { ...req.query }, writable: true, configurable: true });
        next();
    });
    const parameters = scan.put.apiDoc.parameters;
    const put = Object.assign((req, res) => {
        received.push({ query: req.query, url: req.originalUrl });
        res.json({ accepted: true });
    }, { apiDoc: { operationId: "channelScan", parameters, responses: { 200: { description: "OK" } } } });
    const apiDoc = feature
        ? { swagger: "2.0", info: { title: "scan query transport", version: "1" }, basePath: "/api", paths: {} }
        : { openapi: "3.0.3", info: { title: "scan query transport", version: "1" }, servers: [{ url: "/api" }], paths: {} };
    await initialize({ app, apiDoc, paths: [{ path: "/config/channels/scan", module: { put } }] });
    const { client } = await listen(t, app);
    // 旧SDKは実際のSwaggerパラメーター、5.0は同じ定義から生成済みのmanifestを使う。
    if (feature) { client._docs = { ...apiDoc, paths: { "/config/channels/scan": { parameters: [], put: { ...put.apiDoc, tags: ["config"] } } } }; }
    return { client, received };
}

it("SDKのCSV配列は1000件近くても1キーで送り、後続のskipChを失わない", async t => {
    const { client, received } = await scanFixture(t);
    const channels = Array.from({ length: 999 }, (_unused, i) => `C${i}`);
    const skipCh = ["C13", "C14"];
    await client.channelScan({ route: "CATV", source: "list", channels, skipCh });
    assert.equal(received.length, 1);
    const url = new URL(received[0].url, "http://localhost");
    assert.equal(url.searchParams.getAll("channels").length, 1);
    assert.equal(url.searchParams.getAll("skipCh").length, 1);
    assert.deepEqual(received[0].query.channels, channels);
    assert.deepEqual(received[0].query.skipCh, skipCh);
});

it("SDKのoption.queryのCSV配列も定義どおり送り、multi配列は繰返しを保つ", async t => {
    const { client, received } = await scanFixture(t);
    const query = { route: "CATV", source: "list", channels: ["4-", "73750"], skipCh: ["4-"] };
    await client.call("channelScan", {}, { query });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].query.channels, ["4-", "73750"]);
    assert.deepEqual(received[0].query.skipCh, ["4-"]);
    assert.equal(new URL(received[0].url, "http://localhost").searchParams.getAll("channels").length, 1);
    assert.deepEqual(query.channels, ["4-", "73750"]);
    assert.deepEqual(query.skipCh, ["4-"]);
    client._docs = { paths: { "/multi": { parameters: [], get: { operationId: "fixtureMulti", tags: ["config"], parameters: [feature
        ? { in: "query", name: "items", type: "array", items: { type: "string" }, collectionFormat: "multi" }
        : { in: "query", name: "items", schema: { type: "array", items: { type: "string" } }, style: "form", explode: true }] } } } };
    // CSV以外の既存の繰返し形式は変更しない。
    let sent;
    t.mock.method(client, "request", async (_method, _path, option) => { sent = option.query.items; return { body: [] }; });
    await client.call("fixtureMulti", { items: ["a", "b"] });
    assert.deepEqual(sent, ["a", "b"]);
});


it("SDKの空CSV配列は従来どおりキーを省略し、presetに空channelsを追加しない", async t => {
    const { client, received } = await scanFixture(t);
    await client.channelScan({ route: "CATV", source: "preset", channels: [], skipCh: [] });
    assert.equal(received.length, 1);
    const url = new URL(received[0].url, "http://localhost");
    assert.equal(url.searchParams.has("channels"), false);
    assert.equal(url.searchParams.has("skipCh"), false);
    assert.equal("channels" in received[0].query, false);
    assert.equal("skipCh" in received[0].query, false);
    client._docs = { paths: { "/csv": { parameters: [], get: { operationId: "fixtureEmptyCSV", tags: ["config"], parameters: [feature
        ? { in: "query", name: "items", type: "array", items: { type: "string" }, collectionFormat: "csv" }
        : { in: "query", name: "items", schema: { type: "array", items: { type: "string" } }, style: "form", explode: false }] } } } };
    let sent;
    t.mock.method(client, "request", async (_method, _path, option) => { sent = option.query; return { body: [] }; });
    await client.call("fixtureEmptyCSV", { items: [] });
    assert.equal("items" in sent, false);
});

it("SDKは符号化済みURLが8192byteを超えるスキャンを送らない", async t => {
    const { client, received } = await scanFixture(t);
    const channels = Array.from({ length: 4096 }, (_unused, i) => `C${i}`);
    await assert.rejects(client.channelScan({ route: "CATV", source: "list", channels, skipCh: ["C13"] }), /スキャン条件.*長すぎ/);
    assert.equal(received.length, 0);
});


it("SDKは8192byteのCSVスキャンを送り、1byte超過した指定だけを拒否する", async t => {
    const { client, received } = await scanFixture(t);
    const channels = [...Array.from({ length: 7 }, () => "x".repeat(1024)), "z"];
    const encoded = () => "/api/config/channels/scan?" + new URLSearchParams({ route: "CATV", source: "list", channels: channels.join(",") });
    channels[7] += "z".repeat(8192 - Buffer.byteLength(encoded()));
    assert.equal(Buffer.byteLength(encoded()), 8192);
    await client.channelScan({ route: "CATV", source: "list", channels });
    assert.equal(received.length, 1);
    assert.equal(Buffer.byteLength(received[0].url), 8192);
    assert.deepEqual(received[0].query.channels, channels);
    channels[7] += "z";
    await assert.rejects(client.channelScan({ route: "CATV", source: "list", channels }), /スキャン条件.*長すぎ/);
    assert.equal(received.length, 1);
});

for (const pairs of [1000, 1001]) {
    it(`クエリーパーサー上限の${pairs}キーは受付前に400で拒否し、後続のskipChを黙って捨てない`, async t => {
        const app = express();
        app.put("/api/config/channels/scan", (req, res, next) => Promise.resolve(scan.put(req, res, next)).catch(next));
        const previous = _.tuner;
        const attempts = t.mock.fn(() => []);
        _.tuner = { getScanAttempts: attempts };
        t.after(() => { _.tuner = previous; });
        const { origin } = await listen(t, app);
        const query = [...Array.from({ length: pairs - 1 }, () => "x=1"), "skipCh=C13"].join("&");
        const response = await fetch(origin + "/api/config/channels/scan?" + query, { method: "PUT" });
        assert.equal(response.status, 400);
        assert.match((await response.json()).reason, /1000.*未満/);
        assert.equal(attempts.mock.callCount(), 0);
    });
}

for (const length of [8192, 8193]) {
    it(`スキャンURLの${length}byte境界を受付前に検査する`, async t => {
        const app = express();
        app.put("/api/config/channels/scan", (req, res, next) => Promise.resolve(scan.put(req, res, next)).catch(next));
        const previous = _.tuner;
        const attempts = t.mock.fn(() => []);
        _.tuner = { getScanAttempts: attempts };
        t.after(() => { _.tuner = previous; });
        const { origin } = await listen(t, app);
        const beginning = "/api/config/channels/scan?x=";
        const response = await fetch(origin + beginning + "x".repeat(length - beginning.length), { method: "PUT" });
        assert.equal(response.status, 400);
        const reason = (await response.json()).reason;
        assert.equal(reason.includes("8192"), length > 8192, reason);
        assert.equal(attempts.mock.callCount(), length > 8192 ? 0 : 1);
    });
}
