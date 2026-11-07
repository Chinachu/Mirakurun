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
      "/channels/{type}/{channel}/stream": {
        parameters: [{ in: "path", name: "type", required: true }, { in: "path", name: "channel", required: true }],
        get: {
          operationId: "getChannelStream",
          tags: ["channels", "stream"],
          parameters: [{ in: "query", name: "decode" }, { in: "query", name: "format" }, { in: "query", name: "tsmfRelTs" }]
        }
      }
    }
  };

  function run(port) {
    return new Promise(resolve => {
      const proc = childProcess.spawn(process.execPath, ["lib/remote", "127.0.0.1", String(port), "BS4K", "C19", "decode", "tlv"], { cwd: root });
      let stderr = "";
      proc.stderr.on("data", data => stderr += data);
      proc.on("close", code => resolve({ code, stderr }));
    });
  }

  it("exits with 2 if the remote Mirakurun has refused the request, and with 1 if not connected", async () => {
    const requested = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/api/docs") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(docs));
        return;
      }
      requested.push(req.url);
      res.statusCode = 406;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 406, reason: "Requested Stream Format Unavailable" }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const refused = await run(port);
      assert.strictEqual(refused.code, 2, refused.stderr);
      assert.deepStrictEqual(requested, ["/api/channels/BS4K/C19/stream?decode=1&format=tlv"]);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    const notConnected = await run(port);
    assert.strictEqual(notConnected.code, 1, notConnected.stderr);
  });
});
