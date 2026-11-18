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
const http = require("node:http");
const { default: Client } = require("../lib/client");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function docs(supported) {
    return { paths: { "/channels/{type}/{channel}/stream": { parameters: supported ? [{ in: "query", name: "tsmfRelTs" }] : [] } } };
}
async function fixture(t, handler) {
    const paths = [];
    const server = http.createServer((request, response) => {
        paths.push(request.url);
        handler(request, response);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const client = new Client();
    client.host = "127.0.0.1";
    client.port = server.address().port;
    return { client, paths };
}
function json(response, status, body) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

for (const supported of [true, false]) {
    it(`[remote-capabilities.spec] 参照用キーは管理docsを取得せず公開capability=${supported}を使う`, async t => {
        const secret = "sk-test-capability";
        const { client, paths } = await fixture(t, (request, response) => {
            if (request.url === "/api/auth/connection") {
                json(response, 200, { capabilities: { channelStreamTsmfRelTs: supported } });
            } else { json(response, 403, { reason: "管理APIです。" }); }
        });
        assert.equal(await client.supportsChannelStreamTsmfRelTs(), supported);
        assert.deepEqual(paths, ["/api/auth/connection"]);
    });
}
for (const [status, body, supported] of [
    [404, {}, true], [405, {}, false], [200, { protocol: 1 }, true]
]) {
    it(`[remote-capabilities.spec] 旧サーバーの接続情報(${status})だけはdocsへ戻して対応=${supported}を判定する`, async t => {
        const { client, paths } = await fixture(t, (request, response) => {
            if (request.url === "/api/auth/connection") { json(response, status, body); }
            else { assert.equal(request.url, "/api/docs"); json(response, 200, docs(supported)); }
        });
        assert.equal(await client.supportsChannelStreamTsmfRelTs(), supported);
        assert.deepEqual(paths, ["/api/auth/connection", "/api/docs"]);
    });
}
for (const body of [{ protocol: 1, authEnabled: true }, { capabilities: {} }, { capabilities: { channelStreamRawTsmf: false } }]) {
    it(`[legacy-capability-docs] 公開情報に相対TScapabilityがなくdocsが403なら未対応として返す (${JSON.stringify(body)})`, async t => {
        const secret = "sk-old-connection-fixture";
        const { client, paths } = await fixture(t, (request, response) => {
            assert.equal(request.headers.authorization, `Bearer ${secret}`);
            if (request.url === "/api/auth/connection") { json(response, 200, body); }
            else { assert.equal(request.url, "/api/docs"); json(response, 403, { reason: "このAPIは参照用キーでは利用できません。" }); }
        });
        assert.equal(await client.supportsChannelStreamTsmfRelTs({ headers: { Authorization: `Bearer ${secret}` } }), false);
        assert.deepEqual(paths, ["/api/auth/connection", "/api/docs"]);
    });
}
for (const status of [401, 500, 503]) {
    it(`[legacy-capability-docs] docsの${status}を未対応に読み替えない`, async t => {
        const { client, paths } = await fixture(t, (request, response) => {
            if (request.url === "/api/auth/connection") { json(response, 200, { protocol: 1 }); }
            else { json(response, status, { reason: "仕様を取得できません。" }); }
        });
        await assert.rejects(client.supportsChannelStreamTsmfRelTs(), error => error.status === status);
        assert.deepEqual(paths, ["/api/auth/connection", "/api/docs"]);
    });
}
it("[legacy-capability-docs] 接続情報のない旧サーバーでdocsが403なら要求エラーを保持する", async t => {
    const { client, paths } = await fixture(t, (request, response) => json(response,
        request.url === "/api/auth/connection" ? 404 : 403, {}));
    await assert.rejects(client.supportsChannelStreamTsmfRelTs(), error => error.status === 403);
    assert.deepEqual(paths, ["/api/auth/connection", "/api/docs"]);
});
it("[legacy-capability-docs] docs待ちの中止は未対応に読み替えない", { timeout: 5000 }, async t => {
    const entered = deferred(); const controller = new AbortController();
    const { client, paths } = await fixture(t, (request, response) => {
        if (request.url === "/api/auth/connection") { json(response, 200, { protocol: 1 }); }
        else { entered.resolve(); }
    });
    const pending = client.supportsChannelStreamTsmfRelTs({ signal: controller.signal });
    const rejected = assert.rejects(pending);
    await entered.promise; controller.abort(new Error("cancel legacy capability probe"));
    await rejected;
    assert.deepEqual(paths, ["/api/auth/connection", "/api/docs"]);
});

it("[remote-capabilities.spec] 不正な対応情報をdocsで上書きしない", async t => {
    const { client, paths } = await fixture(t, (_request, response) => json(response, 200,
        { capabilities: { channelStreamTsmfRelTs: "true" } }));
    await assert.rejects(client.supportsChannelStreamTsmfRelTs(), /相対TSの対応情報が不正/);
    assert.deepEqual(paths, ["/api/auth/connection"]);
});
for (const status of [401, 403, 500, 503]) {
    it(`[remote-capabilities.spec] 接続情報の${status}を旧サーバー扱いせず呼出元へ返す`, async t => {
        const { client, paths } = await fixture(t, (_request, response) => json(response, status, { reason: "接続情報を取得できません。" }));
        await assert.rejects(client.supportsChannelStreamTsmfRelTs(), error => error.status === status);
        assert.deepEqual(paths, ["/api/auth/connection"]);
    });
}
it("[remote-capabilities.spec] 公開capabilityの応答待ちを中断し、docs取得を始めない", { timeout: 5000 }, async t => {
    const entered = deferred();
    const controller = new AbortController();
    const { client, paths } = await fixture(t, () => entered.resolve());
    const result = client.supportsChannelStreamTsmfRelTs({ signal: controller.signal });
    const rejected = assert.rejects(result);
    await entered.promise;
    controller.abort(new Error("終了要求"));
    await rejected;
    assert.deepEqual(paths, ["/api/auth/connection"]);
});

for (const supported of [true, false]) {
    it(`[remote-capabilities.spec] 生TSMFの明示capability=${supported}を管理docsなしで判定する`, async t => {
        const secret = "sk-raw-capability";
        const { client, paths } = await fixture(t, (request, response) => {
            json(response, 200, { capabilities: { channelStreamRawTsmf: supported } });
        });
        assert.equal(await client.supportsChannelStreamRawTsmf(), supported);
        assert.deepEqual(paths, ["/api/auth/connection"]);
    });
}
for (const status of [404, 405]) {
    for (const supported of [true, false]) {
        it(`[remote-capabilities.spec] 4.x docsの専用rawTsmfで対応=${supported}を確認する (${status})`, async t => {
            const { client, paths } = await fixture(t, (request, response) => {
                if (request.url === "/api/auth/connection") { json(response, status, {}); }
                else { json(response, 200, { paths: { "/channels/{type}/{channel}/stream": {
                    parameters: [{ name: "format" }, ...(supported ? [{ name: "rawTsmf" }] : [])]
                } } }); }
            });
            assert.equal(await client.supportsChannelStreamRawTsmf(), supported);
            assert.deepEqual(paths, ["/api/auth/connection", "/api/docs"]);
        });
    }
}
for (const body of [{ protocol: 1 }, { capabilities: { channelStreamTsmfRelTs: true } }]) {
    it(`[remote-capabilities.spec] 5.0接続情報にrawが無い場合はdocsへ進まない (${JSON.stringify(body)})`, async t => {
        const { client, paths } = await fixture(t, (_request, response) => json(response, 200, body));
        assert.equal(await client.supportsChannelStreamRawTsmf(), false);
        assert.deepEqual(paths, ["/api/auth/connection"]);
    });
}
for (const supported of [null, "true", 1]) {
    it(`[remote-capabilities.spec] 不正な生TSMF capabilityを未対応へ読み替えない (${JSON.stringify(supported)})`, async t => {
        const { client, paths } = await fixture(t, (_request, response) => json(response, 200,
            { capabilities: { channelStreamRawTsmf: supported } }));
        await assert.rejects(client.supportsChannelStreamRawTsmf());
        assert.deepEqual(paths, ["/api/auth/connection"]);
    });
}
for (const status of [401, 403, 500, 503]) {
    it(`[remote-capabilities.spec] 生TSMF照会の${status}は旧サーバー扱いせず返す`, async t => {
        const { client, paths } = await fixture(t, (_request, response) => json(response, status, { reason: "対応情報を取得できません。" }));
        await assert.rejects(client.supportsChannelStreamRawTsmf(), error => error.status === status);
        assert.deepEqual(paths, ["/api/auth/connection"]);
    });
}
it("[remote-capabilities.spec] 生TSMF capability照会の応答待ちを中断し、追加要求を始めない", { timeout: 5000 }, async t => {
    const entered = deferred();
    const controller = new AbortController();
    const { client, paths } = await fixture(t, () => entered.resolve());
    const pending = client.supportsChannelStreamRawTsmf({ signal: controller.signal });
    const rejected = assert.rejects(pending);
    await entered.promise;
    controller.abort(new Error("終了要求"));
    await rejected;
    assert.deepEqual(paths, ["/api/auth/connection"]);
});
it("[remote-capabilities.spec] SDKの明示した生TSMF指定をチャンネル配信queryへ渡す", async t => {
    const input = Buffer.from([0x47, 0x00, 0x2F, 0x10]);
    const { client, paths } = await fixture(t, (_request, response) => {
        response.writeHead(200, { "Content-Type": "video/MP2T" }); response.end(input);
    });
    client._docs = { paths: { "/channels/{type}/{channel}/stream": { get: { operationId: "getChannelStream", tags: ["stream"] },
        parameters: ["type", "channel", "decode", "format", "rawTsmf"].map(name => ({ name, in: ["type", "channel"].includes(name) ? "path" : "query" })) } } };
    const stream = await client.getChannelStream({ type: "BS4K", channel: "C19", decode: false, format: "ts", rawTsmf: true });
    const output = [];
    for await (const chunk of stream) { output.push(chunk); }
    assert.deepEqual(Buffer.concat(output), input);
    assert.equal(paths.length, 1);
    const request = new URL(paths[0], "http://localhost");
    assert.equal(request.pathname, "/api/channels/BS4K/C19/stream");
    assert.equal(request.searchParams.get("decode"), "0");
    assert.equal(request.searchParams.get("format"), "ts");
    assert.equal(request.searchParams.get("rawTsmf"), "true");
    assert.equal(request.searchParams.has("tsmfRelTs"), false);
});

for (const waiting of ["docs", "channel"]) {
    it(`[remote-capabilities.spec] チャンネルの${waiting}待ちを呼出元のsignalで中断する`, { timeout: 5000 }, async t => {
        const entered = deferred(), controller = new AbortController();
        const { client, paths } = await fixture(t, () => entered.resolve());
        if (waiting === "channel") {
            client._docs = { paths: { "/channels/{type}/{channel}": {
                parameters: [{ in: "path", name: "type" }, { in: "path", name: "channel" }],
                get: { operationId: "getChannel", tags: ["channels"] }
            } } };
        }
        const result = client.getChannel("BS4K", "C19", { signal: controller.signal });
        const rejected = assert.rejects(result);
        await entered.promise;
        controller.abort(new Error("metadata deadline"));
        await rejected;
        assert.deepEqual(paths.map(value => new URL(value, "http://localhost").pathname),
            [waiting === "docs" ? "/api/docs" : "/api/channels/BS4K/C19"]);
    });
}
