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
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const feature = !fs.existsSync(path.join(__dirname, "../src/server"));
const modules = path.join(__dirname, feature ? "../lib/Mirakurun" : "../lib/server/modules");
const operations = path.join(__dirname, feature ? "../lib/Mirakurun/api" : "../lib/server/api");
const statusPath = path.join(modules, "status.js");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {} } };
const _ = require(path.join(modules, "_")).default;
const Service = require(path.join(modules, "Service")).default;
const handlers = [
    ["playlist", require(path.join(operations, "iptv/playlist")).get],
    ["lineup.json", require(path.join(operations, "iptv/lineup.json")).get]
];

for (const [name, handler] of handlers) {
    for (const [label, localFormat, canOutputTS] of [
        ["通常のTS", "ts", true],
        ["ローカルではTSと見えるリモートTLV", "ts", true],
        ["変換できないTLV", "tlv", false]
    ]) {
        it(`IPTV ${name}: ${label}でも出力形式をTSに限定する`, async t => {
            const previous = { service: _.service, tuner: _.tuner, config: _.config };
            t.after(() => Object.assign(_, previous));
            const channel = { type: "BS", channel: "C19", route: "CATV", getFormat: () => localFormat, remoteFormat: "tlv" };
            const targets = [{ channel }];
            const service = { id: 1100101, networkId: 11, serviceId: 101, type: 0xAD,
                name: label, logoId: -1, channel, targets, getOrder: () => 0 };
            _.service = { items: [service, { ...service, id: 1100200, type: 0xC0 }] };
            _.config = { server: { defaultTlvStreamFormat: "tlv" } };
            const formats = [];
            _.tuner = { getOutputFormat: (received, format) => {
                assert.equal(received, targets); formats.push(format); return canOutputTS ? "ts" : null;
            } };
            t.mock.method(Service, "isLogoDataExists", async () => false);
            const app = express();
            app.get(`/api/iptv/${name}`, (req, res, next) => Promise.resolve(handler(req, res)).catch(next));
            const server = app.listen(0, "127.0.0.1");
            t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
            await new Promise(resolve => server.once("listening", resolve));
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/iptv/${name}`);
            assert.equal(response.status, 200);
            const body = await response.text();
            const urls = name === "playlist" ? body.split("\n").filter(line => line.startsWith("http")) : JSON.parse(body).map(row => row.URL);
            assert.deepEqual(formats, ["ts"]);
            assert.equal(urls.length, canOutputTS ? 1 : 0);
            for (const url of urls) {
                const stream = new URL(url);
                assert.equal(stream.pathname, "/api/services/1100101/stream");
                assert.equal(stream.searchParams.get("format"), "ts");
            }
        });
    }
}
