const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const db = require("../lib/Mirakurun/db");

function createPrograms(count) {
  const programs = [];
  for (let i = 0; i < count; i++) {
    programs.push({
      id: 3239101024 * 100000 + i,
      eventId: i,
      serviceId: 1024,
      networkId: 32391,
      startAt: 1700000000000 + i * 60000,
      duration: 1800000,
      isFree: true,
      name: `番組${i}`,
      description: "説明\n\"引用\"",
      extended: { "番組内容": "内容".repeat(200) }
    });
  }
  return programs;
}

describe("[db.spec] db.ts: savePrograms() / loadPrograms()", () => {
  let tmpDir;
  let originalPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-db-"));
    originalPath = process.env.PROGRAMS_DB_PATH;
  });

  after(() => {
    if (originalPath === undefined) {
      delete process.env.PROGRAMS_DB_PATH;
    } else {
      process.env.PROGRAMS_DB_PATH = originalPath;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the same JSON as JSON.stringify and loads it back", async () => {
    process.env.PROGRAMS_DB_PATH = path.join(tmpDir, "programs.json");
    const programs = createPrograms(500); // 書き出しの 1 回分より大きいデータ

    await db.savePrograms(programs, "integrity-a");

    const json = fs.readFileSync(process.env.PROGRAMS_DB_PATH, "utf8");
    assert.strictEqual(json, JSON.stringify([{ __integrity__: "integrity-a" }, ...programs]));
    assert.deepStrictEqual(await db.loadPrograms("integrity-a"), programs);
    assert.deepStrictEqual(await db.loadPrograms("integrity-a", true), programs);
    assert.deepStrictEqual(await db.loadPrograms("integrity-b"), []);
  });

  it("does not modify the given array", async () => {
    process.env.PROGRAMS_DB_PATH = path.join(tmpDir, "programs.json");
    const programs = createPrograms(3);

    await db.savePrograms(programs, "integrity-a");

    assert.strictEqual(programs.length, 3);
    assert.strictEqual(programs[0].eventId, 0);
  });

  it("overwrites a larger existing file", async () => {
    process.env.PROGRAMS_DB_PATH = path.join(tmpDir, "programs.json");

    await db.savePrograms(createPrograms(100), "integrity-a");
    await db.savePrograms(createPrograms(1), "integrity-a");

    assert.deepStrictEqual(await db.loadPrograms("integrity-a"), createPrograms(1));
  });

  it("saves an empty array", async () => {
    process.env.PROGRAMS_DB_PATH = path.join(tmpDir, "programs.json");

    await db.savePrograms([], "integrity-a");

    assert.strictEqual(fs.readFileSync(process.env.PROGRAMS_DB_PATH, "utf8"), "[{\"__integrity__\":\"integrity-a\"}]");
    assert.deepStrictEqual(await db.loadPrograms("integrity-a"), []);
  });

  it("keeps the existing file when saving fails", async () => {
    process.env.PROGRAMS_DB_PATH = path.join(tmpDir, "programs.json");
    const programs = createPrograms(500);
    await db.savePrograms(programs, "integrity-a");
    const before = fs.readFileSync(process.env.PROGRAMS_DB_PATH);

    // JSON.stringify が途中の番組で失敗する
    const broken = createPrograms(500);
    broken[400].extra = 1n;
    await db.savePrograms(broken, "integrity-a");

    assert.ok(fs.readFileSync(process.env.PROGRAMS_DB_PATH).equals(before));
    assert.strictEqual(fs.existsSync(`${process.env.PROGRAMS_DB_PATH}.tmp`), false);
    assert.deepStrictEqual(await db.loadPrograms("integrity-a"), programs);
  });

  it("creates the missing directory", { timeout: 5000 }, async () => {
    process.env.PROGRAMS_DB_PATH = path.join(tmpDir, "missing", "dir", "programs.json");
    const programs = createPrograms(2);

    await db.savePrograms(programs, "integrity-a");

    assert.deepStrictEqual(await db.loadPrograms("integrity-a"), programs);
  });
});
