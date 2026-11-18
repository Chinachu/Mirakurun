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
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { default: Client } = require("../lib/client");

async function serve(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const client = new Client();
    client.host = "127.0.0.1";
    client.port = server.address().port;
    return client;
}

function docs(res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ paths: { "/channels": { parameters: [], get: { operationId: "getChannels", tags: ["channels"] } } } }));
}

describe("[client-operation-options.spec] operation Docs options", () => {
    it("Docsの取得には操作用のクエリ・ヘッダー・priorityを使わない", async t => {
        const requests = [];
        const client = await serve(t, (req, res) => {
            requests.push({ url: req.url, operation: req.headers["x-operation"], priority: req.headers["x-mirakurun-priority"] });
            if (new URL(req.url, "http://localhost").pathname === "/api/docs") { docs(res); return; }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("[]");
        });
        client.priority = 2;
        const option = { query: { operationOnly: "channels" }, headers: { "X-Operation": "channels" }, priority: 7 };
        assert.deepEqual((await client.call("getChannels", {}, option)).body, []);
        assert.deepEqual(requests, [
            { url: "/api/docs", operation: undefined, priority: "2" },
            { url: "/api/channels?operationOnly=channels", operation: "channels", priority: "7" }
        ]);
    });

    it("Docsの取得が失敗しても呼び出し元のオプションを変更しない", async t => {
        const client = await serve(t, (_req, res) => {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end("{}");
        });
        const controller = new AbortController();
        const option = {
            query: { operationOnly: "channels" },
            headers: { "X-Operation": "channels" },
            body: { value: "operation body" },
            signal: controller.signal
        };
        const expected = { ...option, query: { ...option.query }, headers: { ...option.headers }, body: { ...option.body } };
        await assert.rejects(client.call("getChannels", {}, option), error => error.status === 503);
        assert.deepEqual(option, expected);
    });
});
