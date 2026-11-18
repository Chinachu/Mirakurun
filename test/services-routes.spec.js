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
require("reflect-metadata");
const { beforeEach, afterEach, it } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const feature = fs.existsSync(path.join(__dirname, "../src/Mirakurun"));
const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
const apiPrefix = feature ? `${prefix}/api` : "../lib/server/api";
if (feature) {
    const statusPath = require.resolve(`${prefix}/status`);
    require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true,
        default: { epg: {}, epgByStream: {}, streamCount: {}, errorCount: {} } } };
}
const express = require("express");
const _ = require(`${prefix}/_`).default;
const Channel = require(`${prefix}/Channel`).default;
const Service = require(`${prefix}/Service`).default;
const ServiceItem = require(`${prefix}/ServiceItem`).default;
const list = require(`${apiPrefix}/services`).get;
const byChannel = require(`${apiPrefix}/channels/{type}/{channel}/services`).get;
const channelDetail = require(`${apiPrefix}/channels/{type}/{channel}`).get;
const serviceDetail = require(`${apiPrefix}/channels/{type}/{channel}/services/{id}`).get;
let server;
let base;
let live;
let primary;
let secondary;
beforeEach(async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const previous = { config: _.config, event: _.event, tuner: _.tuner, service: _.service, channel: _.channel };
    t.after(() => Object.assign(_, previous));
    _.config = { server: { disableEITParsing: true }, channels: [
        { name: "Satellite", type: "BS4K", channel: "BS01_0", route: "SAT", commandVars: { secret: "hidden" } },
        { name: "Cable", type: "CATV", channel: "C19", route: "CATV", commandVars: { secret: "hidden" } },
        { name: "Other", type: "GR", channel: "27", route: "TER" }
    ] };
    _.event = feature ? { emit: () => true } : new (require(`${prefix}/Event`).default)();
    _.tuner = { typeExists: () => true };
    if (!feature) { t.mock.method(require(`${prefix}/Event`).default, "emit", () => true); }
    _.service = new Service();
    t.mock.method(_.service, "save", () => {});
    _.channel = new Channel();
    t.mock.method(_.channel, "save", () => {});
    [primary, secondary] = _.channel.items;
    for (const channel of [primary, secondary]) {
        channel.setStreams([{ networkId: 11, streamId: 45168, format: "tlv" }]);
    }
    live = new ServiceItem(primary, 11, 101, "Both routes", 1, 1, 1, true, 0, 45168, false);
    _.service.add(live);
    _.service.add(new ServiceItem(_.channel.items[2], 0x7FE0, 102, "Other", 1));
    t.mock.method(Service, "isLogoDataExists", async (_networkId, logoId) => logoId === 1);
    const app = express();
    app.disable("x-powered-by");
    if (!feature) { app.use(require(`${prefix}/express-query-shim`).expressQueryShim); }
    app.use((req, _res, next) => {
        req.auth = req.headers["x-test-public"]
            ? { role: "viewer", publicOnly: true } : { role: "admin", publicOnly: false };
        for (const key of ["networkId", "serviceId", "type"]) {
            if (req.query[key] !== undefined) { req.query[key] = Number(req.query[key]); }
        }
        if (req.query.hasLogoData !== undefined) { req.query.hasLogoData = req.query.hasLogoData === "true"; }
        next();
    });
    const operation = handler => (req, res, next) => {
        if (req.params.id !== undefined) { req.params.id = Number(req.params.id); }
        return Promise.resolve(handler(req, res, next)).catch(next);
    };
    app.get("/api/services", operation(list));
    app.get("/api/services/:id", operation(require(`${apiPrefix}/services/{id}`).get));
    app.get("/api/channels/:type/:channel/services", operation(byChannel));
    app.get("/api/channels/:type/:channel/services/:id", operation(serviceDetail));
    app.get("/api/channels/:type/:channel", operation(channelDetail));
    app.use((error, _req, res, _next) => res.status(500).json({ reason: error.message }));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
async function get(url, publicOnly = false) {
    const response = await fetch(base + url, { headers: publicOnly ? { "x-test-public": "1" } : {} });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
}
for (const publicOnly of [false, true]) {
    for (const query of ["channel.type=CATV&channel.channel=C19", "channel.type=CATV", "channel.channel=C19"]) {
        it(`[services-routes] 第2経路も一覧で検索する (${query}, public:${publicOnly})`, async () => {
            const services = await get(`/api/services?${query}`, publicOnly);
            assert.deepEqual(services.map(item => item.id), [live.id]);
            assert.deepEqual(services[0].channel, { type: "BS4K", channel: "BS01_0", route: "SAT" });
            assert.equal(JSON.stringify(services).includes("hidden"), false);
        });
    }
    it(`[services-routes] チャンネルの詳細・一覧・サービス詳細は第2経路でも一致する (public:${publicOnly})`, async () => {
        const channel = await get("/api/channels/CATV/C19", publicOnly);
        const detail = await get(`/api/channels/CATV/C19/services/${live.id}`, publicOnly);
        const services = await get("/api/channels/CATV/C19/services", publicOnly);
        assert.ok(channel.services.some(item => item.id === live.id));
        assert.equal(detail.id, live.id);
        assert.deepEqual(services.map(item => item.id), [live.id]);
    });
}
it("[services-routes] 種別と番号を異なる経路から組み合わせず、ほかの属性もAND条件で照合する", async () => {
    assert.deepEqual(await get("/api/services?channel.type=BS4K&channel.channel=C19"), []);
    assert.deepEqual(await get("/api/services?channel.channel=C19&networkId=12"), []);
    assert.deepEqual(await get("/api/services?channel.channel=C19&name=Other"), []);
    assert.deepEqual((await get("/api/services?channel.channel=C19&networkId=11&serviceId=101&name=Both%20routes&type=1")).map(item => item.id), [live.id]);
});
it("[services-routes] 未指定は全サービス、経路変更後は現在の経路だけに一致する", async () => {
    assert.deepEqual((await get("/api/services")).map(item => item.id).sort((a, b) => a - b), [live.id, 3273600102]);
    primary.setStreams([{ networkId: 99, streamId: 1, format: "ts" }]);
    assert.deepEqual(await get("/api/services?channel.type=BS4K&channel.channel=BS01_0"), []);
    assert.deepEqual((await get("/api/services?channel.type=CATV&channel.channel=C19")).map(item => item.id), [live.id]);
});
if (!feature) {
    it("[services-routes] 第2経路とロゴ有無を併用して絞り込む", async () => {
        assert.deepEqual((await get("/api/services?channel.channel=C19&hasLogoData=true")).map(item => item.id), [live.id]);
        assert.deepEqual(await get("/api/services?channel.channel=C19&hasLogoData=false"), []);
    });
}
