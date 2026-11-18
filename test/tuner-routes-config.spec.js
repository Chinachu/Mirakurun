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
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const yaml = require("js-yaml");
const { initialize } = require("express-openapi");
const config = require("../lib/Mirakurun/config");
const operation = require("../lib/Mirakurun/api/config/tuners");
const responseAPI = require("../lib/Mirakurun/api");

it("[tuner-routes-config.spec] 空routesだけをOpenAPIで拒否し未指定と有効経路を保存できる", async t => {
    const saved = [];
    t.mock.method(config, "saveTuners", async tuners => { saved.push(tuners); });
    const document = yaml.load(fs.readFileSync(path.join(__dirname, "../api.yml"), "utf8"));
    const app = express(); app.use(express.json());
    initialize({ app, promiseMode: true, apiDoc: { ...document, paths: {} },
        paths: [{ path: "/config/tuners", module: operation }] });
    app.use((error, req, res, next) => responseAPI.responseError(res, error.status || 500, error.message));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}/api/config/tuners`;
    for (const [routes, status] of [[[], 400], [undefined, 200], [["TER"], 200]]) {
        const response = await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify([{ name: "test", types: ["GR"], command: "must-not-run", ...(routes ? { routes } : {}) }]) });
        assert.equal(response.status, status, await response.text());
    }
    assert.equal(saved.length, 2);
    assert.equal(Object.hasOwn(saved[0][0], "routes"), false);
    assert.deepEqual(saved[1][0].routes, ["TER"]);
});
