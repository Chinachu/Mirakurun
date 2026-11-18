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
const { describe, it } = require("node:test");
const assert = require("assert");
const path = require("path");
const http = require("http");
const childProcess = require("child_process");

const root = path.join(__dirname, "..");

// lib/remote: リモートの Mirakurun が断った要求 (406 など) は終了コード 2 (TunerDevice が起動し直さない)
describe("[remote.spec] lib/remote", () => {
  const docs = {
    swagger: "2.0",
    basePath: "/api",
    paths: {
      // the parameters of the path, as Mirakurun (express-openapi of `parameters` of the module)
      "/channels/{type}/{channel}/stream": {
        parameters: [
          { in: "path", name: "type", required: true }, { in: "path", name: "channel", required: true },
          { in: "query", name: "decode" }, { in: "query", name: "format" }, { in: "query", name: "tsmfRelTs" }
        ],
        get: {
          operationId: "getChannelStream",
          tags: ["channels", "stream"],
          parameters: []
        }
      }
    }
  };

  function run(port, args = ["decode", "tlv", "relTs=3"]) {
    return new Promise(resolve => {
      const proc = childProcess.spawn(process.execPath, ["lib/remote", "127.0.0.1", String(port), "BS4K", "C19", ...args], { cwd: root });
      let stderr = "";
      proc.stderr.on("data", data => stderr += data);
      proc.on("close", code => resolve({ code, stderr }));
    });
  }

  it("[legacy-capability-cli] capabilityのない公開情報とdocs拒否は終了3になり配信要求を送らない", { timeout: 5000 }, async t => {
    const requested = [], key = "sk-old-public-capability-fixture";
    const feature = require("fs").existsSync(path.join(root, "src/Mirakurun"));
    const server = http.createServer((req, res) => {
      requested.push(req.url);
      if (!feature) { assert.strictEqual(req.headers.authorization, `Bearer ${key}`); }
      res.writeHead(req.url === "/api/auth/connection" ? 200 : 403, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/auth/connection" ? { protocol: 1 } : { reason: "管理APIです。" }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const result = await new Promise((resolve, reject) => {
      const proc = childProcess.spawn(process.execPath, ["lib/remote", "127.0.0.1", String(server.address().port), "BS4K", "C19", "ts", "relTs=3"],
        { cwd: root, env: { ...process.env, MIRAKURUN_REMOTE_SECRET_KEY: key, MIRAKURUN_REMOTE_PROTOCOL: "http:" } });
      t.after(() => { if (proc.exitCode === null) { proc.kill(); } });
      let stderr = ""; const stdout = [];
      proc.stderr.on("data", data => stderr += data); proc.stdout.on("data", data => stdout.push(data));
      proc.once("error", reject);
      proc.once("close", code => resolve({ code, stderr, stdout: Buffer.concat(stdout) }));
    });
    assert.strictEqual(result.code, 3, result.stderr);
    assert.strictEqual(result.stdout.length, 0);
    assert.ok(!result.stderr.includes(key));
    assert.deepStrictEqual(requested, ["/api/auth/connection", "/api/docs"]);
  });

  it("exits with 2 if the remote Mirakurun has refused the request, and with 1 if not connected", async () => {
    const requested = [];
    let statusCode = 406;
    let remoteDocs = docs;
    const server = http.createServer((req, res) => {
      if (req.url === "/api/auth/connection") { res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}"); return; }
      if (req.url === "/api/docs") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(remoteDocs));
        return;
      }
      requested.push(req.url);
      res.statusCode = statusCode;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: statusCode }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const refused = await run(port);
      assert.strictEqual(refused.code, 2, refused.stderr);
      assert.deepStrictEqual(requested, ["/api/channels/BS4K/C19/stream?decode=1&format=tlv&tsmfRelTs=3"]);

      // 404/406は相対TS拒否、他の恒久4xxは要求失敗として終了し、408/429/5xxだけ再起動する。
      for (const [status, code] of [[400, 4], [401, 4], [403, 4], [404, 2], [406, 2], [408, 1], [409, 4], [422, 4], [429, 1], [500, 1], [503, 1]]) {
        statusCode = status;
        const startedAt = Date.now();
        const result = await run(port);
        assert.strictEqual(result.code, code, `${status}: ${result.stderr}`);
        // respawned after a while if failed at once (not to request again and again)
        if (code === 1) {
          assert.ok(Date.now() - startedAt >= 1000, `${status}: ${Date.now() - startedAt}ms`);
        }
      }

      // the remote Mirakurun of 4.3.0 or before: tsmfRelTs is not supported (3, not requested), the stream of the channel as before
      requested.length = 0;
      remoteDocs = JSON.parse(JSON.stringify(docs));
      const streamPath = remoteDocs.paths["/channels/{type}/{channel}/stream"];
      streamPath.parameters = streamPath.parameters.filter(param => param.name !== "format" && param.name !== "tsmfRelTs");
      const unsupported = await run(port);
      assert.strictEqual(unsupported.code, 3, unsupported.stderr);
      assert.deepStrictEqual(requested, []);
      statusCode = 404;
      assert.strictEqual((await run(port, ["decode"])).code, 2);
      assert.deepStrictEqual(requested, ["/api/channels/BS4K/C19/stream?decode=1"]);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    const notConnected = await run(port);
    assert.strictEqual(notConnected.code, 1, notConnected.stderr);
  });
});
