const { describe, it, before } = require("node:test");
const assert = require("assert");
const path = require("path");

// status.ts のタイマーでテストのプロセスが終了しなくなるため差し替える
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
require.cache[statusPath] = {
  id: statusPath,
  filename: statusPath,
  loaded: true,
  exports: { __esModule: true, default: { epg: {}, streamCount: { tsFilter: 0, decoder: 0 } } }
};

const log = require("../lib/Mirakurun/log");
let TunerDevice;

function fakeStream() {
  return {
    writes: [],
    flushes: 0,
    write(chunk, defer) {
      this.writes.push({ length: chunk.length, defer });
    },
    flush() {
      this.flushes++;
    },
    end() {}
  };
}

function device(streams) {
  const d = Object.create(TunerDevice.prototype);
  d._users = new Set(streams.map(_stream => ({ _stream })));
  d._pendingBytes = 0;
  d._flushTimer = null;
  d._flushUsersBound = d._flushUsers.bind(d);
  d._stream = { removeAllListeners() {} };
  d._updated = () => {};
  return d;
}

describe("[tunerdevice.spec] TunerDevice.ts: _streamOnData()", () => {
  before(() => {
    for (const level of ["info", "debug", "warn", "error"]) {
      log[level] = () => {};
    }
    TunerDevice = require("../lib/Mirakurun/TunerDevice").default;
  });

  it("defers writes and flushes all streams after 128KB", () => {
    const streams = [fakeStream(), fakeStream()];
    const d = device(streams);

    for (let i = 0; i < 3; i++) {
      d._streamOnData(Buffer.alloc(40 * 1024));
    }
    assert.deepStrictEqual(streams.map(s => s.flushes), [0, 0]);
    d._streamOnData(Buffer.alloc(40 * 1024));
    assert.deepStrictEqual(streams.map(s => s.flushes), [1, 1]);
    assert.ok(streams.every(s => s.writes.length === 4 && s.writes.every(w => w.defer === true)));
    assert.strictEqual(d._flushTimer, null);
  });

  it("flushes small inputs within 50ms", async () => {
    const stream = fakeStream();
    const d = device([stream]);

    d._streamOnData(Buffer.alloc(188));
    assert.strictEqual(stream.flushes, 0);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.strictEqual(stream.flushes, 1);
    assert.strictEqual(d._flushTimer, null);
  });

  it("flushes the pending output when the tuner process ends", () => {
    const stream = fakeStream();
    const d = device([stream]);

    d._streamOnData(Buffer.alloc(188));
    d._end();
    assert.strictEqual(stream.flushes, 1);
    assert.strictEqual(d._flushTimer, null);
  });
});
