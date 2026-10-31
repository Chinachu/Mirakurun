const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const http = require("http");
const util = require("util");
const { EventEmitter } = require("events");
const express = require("express");

const api = require("../lib/Mirakurun/api");
const events = require("../lib/Mirakurun/api/events");
const log = require("../lib/Mirakurun/log");
const _ = require("../lib/Mirakurun/_").default;

function createPrograms(count) {
  const programs = [];
  for (let i = 0; i < count; i++) {
    programs.push({
      id: 3273601024 * 100000 + i,
      eventId: i,
      name: `番組${i}`,
      description: "説明\n\"引用\"".repeat(20),
      genres: [{ lv1: 7, lv2: 0, un1: 15, un2: 15 }]
    });
  }
  return programs;
}

// 文字列化された要素の数を数える
function countStringified(items) {
  const counter = { count: 0 };
  const wrapped = items.map(item => ({
    toJSON() {
      ++counter.count;
      return item;
    }
  }));
  return [wrapped, counter];
}

// 書き出した内容を記録する、express.Response の代わり
function createFakeResponse(writeResult) {
  const res = new EventEmitter();
  return Object.assign(res, {
    req: { method: "GET", originalUrl: "/api/fake" },
    destroyed: false,
    headersSent: false,
    chunks: [],
    setHeader() {},
    status() {
      return this;
    },
    writeHead() {
      this.wroteHead = true;
    },
    write(chunk) {
      this.headersSent = true;
      this.chunks.push(chunk);
      return writeResult;
    },
    end(chunk) {
      this.chunks.push(chunk);
      this.ended = true;
    }
  });
}

const tick = () => new Promise(resolve => setImmediate(resolve));

describe("[api.spec] api.ts: responseJSON()", () => {
  let server;
  let port;
  let handler;
  let logError;
  let logged = [];

  before(async () => {
    logError = log.error;
    log.error = (...args) => logged.push(util.format(...args));

    const app = express();
    app.get("/", (req, res) => handler(req, res));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    log.error = logError;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  function request(method = "GET") {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/", method, agent: false }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("close", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          complete: res.complete,
          body: Buffer.concat(chunks).toString("utf8")
        }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("responds a small array with Content-Length, omitting elements that are not JSON values", async () => {
    const body = [1, "文字列", null, undefined, { a: 1, b: undefined }, () => 1];
    handler = (req, res) => api.responseJSON(res, body);

    const res = await request();

    // yieldable-json と同じく、配列の要素が undefined や関数なら出力しない
    assert.strictEqual(res.body, "[1,\"文字列\",null,{\"a\":1}]");
    assert.strictEqual(res.headers["content-type"], "application/json; charset=utf-8");
    assert.strictEqual(res.headers["content-length"], String(Buffer.byteLength(res.body)));
  });

  it("responds an empty array and an object as before", async () => {
    handler = (req, res) => api.responseJSON(res, []);
    assert.strictEqual((await request()).body, "[]");

    const object = { version: "1.0.0", items: [1, 2] };
    handler = (req, res) => api.responseJSON(res, object);
    const res = await request();
    assert.strictEqual(res.body, JSON.stringify(object));
    assert.strictEqual(res.headers["content-length"], String(Buffer.byteLength(res.body)));
  });

  it("writes a large array in chunks with the same JSON", async () => {
    const body = createPrograms(3000);
    handler = (req, res) => api.responseJSON(res, body);

    const res = await request();

    assert.strictEqual(res.body, JSON.stringify(body));
    assert.strictEqual(res.headers["transfer-encoding"], "chunked");
  });

  it("does not stringify the body for HEAD requests", async () => {
    const [body, counter] = countStringified(createPrograms(3000));
    handler = (req, res) => api.responseJSON(res, body);

    const res = await request("HEAD");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, "");
    assert.strictEqual(counter.count, 0);
  });

  it("responds 500 when the array cannot be stringified before writing", { timeout: 5000 }, async () => {
    handler = (req, res) => api.responseJSON(res, [1, { value: 2n }]);
    logged = [];

    const res = await request();

    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(JSON.parse(res.body), { code: 500, reason: null, errors: [] });
    // どの API で失敗したか分かるよう、メソッドと URL を記録する
    assert.strictEqual(logged.length, 1);
    assert.ok(logged[0].includes("`GET /`"), logged[0]);
  });

  it("closes the connection when stringifying fails while writing", { timeout: 5000 }, async () => {
    const body = createPrograms(3000);
    body[2500].value = 2n;
    handler = (req, res) => api.responseJSON(res, body);

    const res = await request();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.complete, false);
    assert.ok(res.body.length > 0);
  });

  it("does not write an error response when stringifying fails after the response has closed", async () => {
    const res = createFakeResponse(true);
    res.destroyed = true;
    logged = [];

    await api.responseJSON(res, [{ value: 2n }]);

    assert.strictEqual(res.wroteHead, undefined);
    assert.strictEqual(res.ended, undefined);
    assert.strictEqual(logged.length, 1);
    assert.ok(logged[0].includes("`GET /api/fake`"), logged[0]);
  });

  it("GET /api/events writes the events as they were when the response started", async () => {
    // 1 回で書き出せない件数のイベント
    const eventLog = createPrograms(3000).map((data, i) => ({ resource: "program", type: "update", data, time: i }));
    const expected = JSON.stringify(eventLog);
    const originalEvent = _.event;
    _.event = { log: eventLog };
    const res = createFakeResponse(true);

    try {
      events.get({}, res);
      // 書き出しの途中で、新しいイベントにより内部の配列が変わる
      for (let i = 0; i < 20; i++) {
        await tick();
        eventLog.push({ resource: "program", type: "create", data: {}, time: -1 });
        eventLog.shift();
      }
      while (!res.ended) {
        await tick();
      }
    } finally {
      _.event = originalEvent;
    }

    assert.strictEqual(res.chunks.join(""), expected);
  });

  it("stops writing without leaving listeners when the response closes while waiting for drain", async () => {
    const [body, counter] = countStringified(createPrograms(3000));
    const res = createFakeResponse(false);

    const result = api.responseJSON(res, body);
    assert.strictEqual(res.chunks.length, 1);
    res.emit("drain");
    await tick();
    assert.strictEqual(res.chunks.length, 2);

    const count = counter.count;
    res.destroyed = true;
    res.emit("close");
    await result;

    assert.strictEqual(res.ended, undefined);
    assert.strictEqual(counter.count, count); // 閉じた後は文字列化しない
    assert.strictEqual(res.listenerCount("drain"), 0);
    assert.strictEqual(res.listenerCount("close"), 0);
  });

  it("stops writing when the client disconnects", { timeout: 10000 }, async () => {
    const [body, counter] = countStringified(createPrograms(20000));
    let response;
    let result;
    handler = (req, res) => {
      response = res;
      result = api.responseJSON(res, body);
    };

    // 最初のデータを受け取った時点で切断する (サーバー側は 16KB ごとに順番を譲るため、全体を書き出す前に検知できる)
    await new Promise(resolve => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", agent: false }, res => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
    });
    await result;

    assert.strictEqual(response.destroyed, true);
    assert.strictEqual(response.listenerCount("drain"), 0);
    assert.ok(counter.count < body.length, `stringified ${counter.count} of ${body.length}`);
  });
});
