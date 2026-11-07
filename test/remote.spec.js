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

  it("exits with 2 if the remote Mirakurun has refused the request, and with 1 if not connected", async () => {
    const requested = [];
    let statusCode = 406;
    let remoteDocs = docs;
    const server = http.createServer((req, res) => {
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

      // refused again (400 / 404 / 406): 2, not available for now (such as 503 for the tuners in use): 1 (respawned as before)
      for (const [status, code] of [[400, 2], [404, 2], [500, 1], [503, 1]]) {
        statusCode = status;
        const result = await run(port);
        assert.strictEqual(result.code, code, `${status}: ${result.stderr}`);
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
