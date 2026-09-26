const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const express = require("express");

const parseQuery = express().get("query parser fn");
const blockedQueryStrings = [
  "[$where]=1",
  "%24where=1",
  "constructor[prototype][$where]=1",
  "name[$where]=1"
];

const siftPath = require.resolve("sift");
let calls = 0;
let lastQuery;
let impl = () => () => true;

function countingFn(query) {
  calls++;
  lastQuery = query;
  return impl();
}

require.cache[siftPath] = {
  id: siftPath,
  filename: siftPath,
  loaded: true,
  exports: countingFn
};

const common = require("../lib/Mirakurun/common");
const { Program } = require("../lib/Mirakurun/Program");
const _ = require("../lib/Mirakurun/_").default;
const programs = require("../lib/Mirakurun/api/programs");
const channels = require("../lib/Mirakurun/api/channels");
const channelsByType = require("../lib/Mirakurun/api/channels/{type}");
const services = require("../lib/Mirakurun/api/services");

function isWhere(err) {
  assert.ok(err instanceof common.WhereQueryError);
  assert.strictEqual(err.status, 400);
  assert.strictEqual(err.code, "WHERE_QUERY");
  return true;
}

function assertWhere(query) {
  assert.throws(() => common.rejectWhere(query), isWhere);
}

function fakeRes() {
  return {
    statusCode: 200,
    writeHead(code) {
      this.statusCode = code;
    },
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {}
  };
}

function programStore() {
  const program = Object.create(Program.prototype);
  program._itemMap = new Map([[1, { id: 1 }]]);
  return program;
}

describe("[query.spec] rejectWhere", () => {
  it("rejects own key $where anywhere sift would compile it", () => {
    const values = ["x"];
    values.$where = "0";

    assertWhere({ $where: "0" });
    assertWhere({ networkId: { $where: "0" } });
    assertWhere({ name: { $not: { $where: "0" } } });
    assertWhere({ items: { $elemMatch: { $where: "0" } } });
    assertWhere({ $or: [{ $where: "0" }] });
    assertWhere({ $and: [{ name: "a" }, { $where: "0" }] });
    assertWhere({ $nor: [{ $where: "0" }] });
    assertWhere({ $or: { $where: "0" } });
    assertWhere({ $and: { $where: "0" } });
    assertWhere({ $nor: { $where: "0" } });
    assertWhere({ tags: ["x", { $where: "0" }] });
    assertWhere(values);
    assertWhere({ $all: [{ $where: "0" }] });
  });

  it("allows queries that are not an own key $where", () => {
    assert.doesNotThrow(() => common.rejectWhere({ name: "news" }));
    assert.doesNotThrow(() => common.rejectWhere({ startAt: { $gte: 1 } }));
    assert.doesNotThrow(() => common.rejectWhere({ name: "$where" }));
    assert.doesNotThrow(() => common.rejectWhere({ "[$where]": "1" }));
    assert.doesNotThrow(() => common.rejectWhere({ hasOwnProperty: "x" }));
  });

  it("rejects queries from the Express extended parser", () => {
    for (const raw of blockedQueryStrings) {
      assertWhere(parseQuery(raw));
    }

    const stripped = parseQuery("__proto__[$where]=1");
    assert.strictEqual("$where" in stripped, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, "$where"), false);
    assert.doesNotThrow(() => common.rejectWhere(stripped));
  });

  it("rejects enumerable inherited $where", () => {
    assertWhere(Object.create({ $where: "0" }));
    const query = Object.create({ $where: "0" });
    query.name = "news";
    assertWhere(query);
    assertWhere(Object.create({ title: { $where: "0" } }));

    const cycle = {};
    cycle.self = cycle;
    assert.doesNotThrow(() => common.rejectWhere(cycle));

    const proto = { title: { $where: "0" } };
    proto.self = proto;
    assertWhere(Object.create(proto));
  });
});

describe("[query.spec] sift is not called for $where", () => {
  beforeEach(() => {
    calls = 0;
    lastQuery = undefined;
    impl = () => () => true;
    _.program = programStore();
    _.channel = {
      items: [],
      findByType() {
        return [];
      }
    };
    _.service = { items: [] };
  });

  it("does not call sift for inherited or Express $where", () => {
    assert.throws(() => _.program.findByQuery(Object.create({ $where: "0" })), isWhere);
    assert.strictEqual(calls, 0);

    calls = 0;
    assert.throws(() => _.program.findByQuery(Object.create({ title: { $where: "0" } })), isWhere);
    assert.strictEqual(calls, 0);

    for (const raw of blockedQueryStrings) {
      calls = 0;
      assert.throws(() => _.program.findByQuery(parseQuery(raw)), isWhere);
      assert.strictEqual(calls, 0);
    }

    calls = 0;
    lastQuery = undefined;
    const stripped = parseQuery("__proto__[$where]=1");
    assert.strictEqual("$where" in stripped, false);
    _.program.findByQuery(stripped);
    assert.strictEqual(calls, 1);
    assert.ok(!("$where" in lastQuery));
  });

  it("findByQuery throws before sift", () => {
    assert.throws(() => _.program.findByQuery({ $where: "0" }), isWhere);
    assert.strictEqual(calls, 0);

    calls = 0;
    _.program.findByQuery({ startAt: { $gte: 1 } });
    assert.strictEqual(calls, 1);
  });

  it("GET handlers return 400 and do not call sift", async () => {
    const handlers = [
      programs.get,
      channels.get,
      (req, res) => channelsByType.get({ ...req, params: { type: "GR" } }, res),
      services.get
    ];

    const blocked = [{ $where: "0" }].concat(blockedQueryStrings.map(parseQuery));

    for (const get of handlers) {
      for (const query of blocked) {
        calls = 0;
        const res = fakeRes();
        await get({ query }, res, () => {
          throw new Error("next");
        });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(calls, 0);
      }

      calls = 0;
      const ok = fakeRes();
      await get({ query: { startAt: { $gte: 1 } } }, ok, () => {
        throw new Error("next");
      });
      assert.notStrictEqual(ok.statusCode, 400);
      assert.strictEqual(calls, 1);
    }
  });

  it("rethrows sift failures, and services passes them to next", async () => {
    impl = () => {
      throw new Error("sift failed");
    };
    const query = { name: "news" };

    for (const get of [programs.get, channels.get, channelsByType.get]) {
      await assert.rejects(async () => get({ query, params: { type: "GR" } }, fakeRes()), (err) => {
        assert.ok(!(err instanceof common.WhereQueryError));
        assert.strictEqual(err.message, "sift failed");
        return true;
      });
    }

    let forwarded;
    await services.get({ query }, fakeRes(), (err) => {
      forwarded = err;
    });
    assert.ok(!(forwarded instanceof common.WhereQueryError));
    assert.strictEqual(forwarded.message, "sift failed");
  });
});

describe("[query.spec] real sift", () => {
  it("executes string $where, and rejectWhere stops it before Function", () => {
    const result = spawnSync(process.execPath, ["-e", `
      const assert = require("assert");
      const common = require("./lib/Mirakurun/common");
      const sift = require("sift");
      const { Program } = require("./lib/Mirakurun/Program");
      const _ = require("./lib/Mirakurun/_").default;
      const programs = require("./lib/Mirakurun/api/programs");

      const payload = "(globalThis.__mirakurunWhereHit = true)";
      const query = { $where: payload };

      assert.strictEqual(globalThis.__mirakurunWhereHit, undefined);
      assert.throws(() => common.rejectWhere(query), (err) => err instanceof common.WhereQueryError);
      assert.strictEqual(globalThis.__mirakurunWhereHit, undefined);

      assert.strictEqual(sift(query)({ id: 1 }), true);
      assert.strictEqual(globalThis.__mirakurunWhereHit, true);
      globalThis.__mirakurunWhereHit = undefined;

      const program = Object.create(Program.prototype);
      program._itemMap = new Map([[1, { id: 1 }]]);
      _.program = program;
      assert.throws(() => program.findByQuery(query), (err) => err instanceof common.WhereQueryError);
      assert.strictEqual(globalThis.__mirakurunWhereHit, undefined);

      const res = {
        statusCode: 200,
        writeHead(code) { this.statusCode = code; },
        setHeader() {},
        end() {}
      };
      programs.get({ query }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(globalThis.__mirakurunWhereHit, undefined);
    `], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8"
    });

    assert.strictEqual(result.status, 0, (result.stderr || "") + (result.stdout || ""));
  });
});
