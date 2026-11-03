const { describe, it, before, after, beforeEach, afterEach, mock } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

// status.ts のタイマーでテストのプロセスが終了しなくなるため差し替える
const statusPath = path.join(__dirname, "../lib/Mirakurun/status.js");
require.cache[statusPath] = {
  id: statusPath,
  filename: statusPath,
  loaded: true,
  exports: { __esModule: true, default: { epg: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { tunerDeviceRespawn: 0 } } }
};

const log = require("../lib/Mirakurun/log");
const _ = require("../lib/Mirakurun/_").default;
let TunerDevice;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-tunerdevice-dvb-"));
const confPath = path.join(dir, "channels.conf");
fs.writeFileSync(confPath, [
  "[27]", "\tDELIVERY_SYSTEM = ISDBT", "\tFREQUENCY = 557142857", "\tBANDWIDTH_HZ = 6000000",
  "[26]", "\tDELIVERY_SYSTEM = ISDBT", "\tFREQUENCY = 551142857", "\tBANDWIDTH_HZ = 6000000"
].join("\n"));

const flush = () => new Promise(resolve => setImmediate(resolve));

// DvbDevice の代わり (DvbDevice と同じく操作を順に実行し、start() は resolveStart() まで完了しない)
class FakeDvb extends EventEmitter {
  constructor() {
    super();
    this.path = "/dev/dvb/adapter9";
    this.isOpen = false;
    this.calls = [];
    this.pendings = [];
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  start(params) {
    return this.serial(() => {
      this.calls.push(["start", params.properties[0][1]]);
      this.isOpen = true;
      return new Promise((resolve, reject) => this.pendings.push({ resolve, reject }));
    });
  }
  async resolveStart() {
    await flush();
    this.pendings.shift().resolve();
    await flush();
  }
  async rejectStart(err) {
    await flush();
    this.pendings.shift().reject(err);
    await flush();
  }
  stopStream() {
    return this.serial(async () => {
      this.calls.push(["stopStream"]);
    });
  }
  close() {
    return this.serial(async () => {
      this.calls.push(["close"]);
      this.isOpen = false;
    });
  }
}

function fakeStream() {
  const stream = new EventEmitter();
  stream.closed = false;
  stream.writes = [];
  stream.ended = false;
  stream.write = chunk => stream.writes.push(chunk);
  stream.flush = () => {};
  stream.end = () => {
    stream.ended = true;
  };
  return stream;
}

function channel(ch) {
  return { type: "GR", channel: ch };
}

function user(id, priority = 0) {
  return { id, priority };
}

function createDevice() {
  const device = new TunerDevice(9, { name: "dvb", types: ["GR"], command: "recpt1 <channel> - -" });
  const dvb = new FakeDvb();
  // _initDvb() と同じ設定 (koffi を使わない)
  device._dvb = dvb;
  device._dvbChannelsConfPath = confPath;
  dvb.on("data", device._streamOnData.bind(device));
  dvb.on("error", device._dvbOnError.bind(device));
  return [device, dvb];
}

describe("[tunerdevice-dvb.spec] TunerDevice.ts: DVB device direct access", () => {
  before(() => {
    for (const level of ["info", "debug", "warn", "error", "fatal"]) {
      log[level] = () => {};
    }
    _.event = { emit: () => true };
    TunerDevice = require("../lib/Mirakurun/TunerDevice").default;
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("tunes, streams data to the user and stops after the last user ends", async () => {
    const [device, dvb] = createDevice();
    const stream = fakeStream();
    const u = user("a");

    const started = device.startStream(u, stream, channel("27"));
    await flush();
    assert.strictEqual(device.isFree, false);
    assert.strictEqual(device.channel.channel, "27");
    await dvb.resolveStart();
    await started;

    assert.deepStrictEqual(dvb.calls, [["start", 557142857]]);
    assert.strictEqual(device.users.length, 1);
    assert.strictEqual(device.pid, null);
    assert.strictEqual(device.command, "/dev/dvb/adapter9 27");

    dvb.emit("data", Buffer.alloc(188));
    assert.strictEqual(stream.writes.length, 1);

    stream.closed = true;
    stream.emit("close");
    assert.strictEqual(stream.ended, true);
    assert.strictEqual(device.isFree, false);

    // 最後のユーザーが終了してから 3 秒で配信を止め、さらに 1 秒で frontend を閉じる
    mock.timers.tick(3000);
    await flush();
    assert.deepStrictEqual(dvb.calls.slice(1), [["stopStream"]]);
    assert.strictEqual(device.isFree, true);
    mock.timers.tick(1000);
    await flush();
    assert.deepStrictEqual(dvb.calls.slice(1), [["stopStream"], ["close"]]);
  });

  it("retunes without closing the frontend when a higher priority user requests another channel", async () => {
    const [device, dvb] = createDevice();
    const low = fakeStream();
    const started = device.startStream(user("low", 0), low, channel("27"));
    await dvb.resolveStart();
    await started;

    const high = fakeStream();
    const switched = device.startStream(user("high", 1), high, channel("26"));
    await flush();
    assert.strictEqual(low.ended, true);
    await dvb.resolveStart();
    await switched;

    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["stopStream"], ["start", 551142857]]);
    assert.deepStrictEqual(device.users.map(u => u.id), ["high"]);
    assert.strictEqual(device.channel.channel, "26");

    // 選局し直した後は、前の選局の後に予約した frontend を閉じるタイマーは動かない
    mock.timers.tick(5000);
    await flush();
    assert.strictEqual(dvb.calls.filter(([name]) => name === "close").length, 0);
  });

  it("keeps the tuner for a new user within 3 seconds after the last user ends", async () => {
    const [device, dvb] = createDevice();
    const first = fakeStream();
    const started = device.startStream(user("a"), first, channel("27"));
    await dvb.resolveStart();
    await started;

    first.closed = true;
    first.emit("close");
    mock.timers.tick(2000);

    const second = fakeStream();
    await device.startStream(user("b"), second, channel("27"));
    mock.timers.tick(2000);
    await flush();

    assert.deepStrictEqual(dvb.calls, [["start", 557142857]]);
    assert.deepStrictEqual(device.users.map(u => u.id), ["b"]);
  });

  it("ends the users who joined while tuning when tuning fails", async () => {
    const [device, dvb] = createDevice();
    const first = fakeStream();
    const started = device.startStream(user("a"), first, channel("27"));
    await flush();

    const joined = fakeStream();
    await device.startStream(user("b"), joined, channel("27"));

    const rejected = assert.rejects(started, /EBUSY/);
    await dvb.rejectStart(Object.assign(new Error("open EBUSY"), { code: "EBUSY", syscall: "open" }));
    await rejected;

    assert.strictEqual(first.ended, true);
    assert.strictEqual(joined.ended, true);
    assert.strictEqual(device.isFree, true);
    assert.strictEqual(device.isFault, false);
    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["close"]]);
  });

  it("becomes fault after the device is missing 3 times in a row", async () => {
    const [device, dvb] = createDevice();
    const missing = () => Object.assign(new Error("open ENODEV"), { code: "ENODEV", syscall: "open" });

    for (let i = 0; i < 3; i++) {
      assert.strictEqual(device.isFault, false);
      const rejected = assert.rejects(device.startStream(user(`u${i}`), fakeStream(), channel("27")), /ENODEV/);
      await dvb.rejectStart(missing());
      await rejected;
    }

    assert.strictEqual(device.isFault, true);
    assert.strictEqual(device.isAvailable, false);
  });

  it("does not become fault by tuning errors other than the missing device", async () => {
    const [device, dvb] = createDevice();
    const busy = () => Object.assign(new Error("open EBUSY"), { code: "EBUSY", syscall: "open" });

    for (let i = 0; i < 3; i++) {
      const rejected = assert.rejects(device.startStream(user(`u${i}`), fakeStream(), channel("27")), /EBUSY/);
      await dvb.rejectStart(busy());
      await rejected;
    }
    for (let i = 0; i < 3; i++) {
      await assert.rejects(device.startStream(user(`m${i}`), fakeStream(), channel("99")), /not found/);
    }

    assert.strictEqual(device.isFault, false);
    assert.strictEqual(device.isFree, true);
  });

  it("is not taken over while tuning by a user without higher priority", async () => {
    const [device, dvb] = createDevice();
    const started = device.startStream(user("a", 0), fakeStream(), channel("27"));
    await flush();

    // 選局を待つ間もユーザーがいるため、ユーザーのいないチューナーとして扱われない
    assert.deepStrictEqual(device.users.map(u => u.id), ["a"]);
    await assert.rejects(device.startStream(user("b", 0), fakeStream(), channel("26")), /higher priority user/);

    await dvb.resolveStart();
    await started;
    assert.deepStrictEqual(dvb.calls, [["start", 557142857]]);
    assert.strictEqual(device.channel.channel, "27");
  });

  it("ends the user whose tuning was taken over by a higher priority user", async () => {
    const [device, dvb] = createDevice();
    const low = fakeStream();
    const started = device.startStream(user("low", 0), low, channel("27"));
    await flush();

    const switched = device.startStream(user("high", 1), fakeStream(), channel("26"));
    await dvb.resolveStart();
    await started;
    assert.strictEqual(low.ended, true);

    await dvb.resolveStart();
    await switched;
    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["stopStream"], ["start", 551142857]]);
    assert.deepStrictEqual(device.users.map(u => u.id), ["high"]);
    assert.strictEqual(device.channel.channel, "26");
  });

  it("does not tune a channel missing in the channels file", async () => {
    const [device, dvb] = createDevice();
    await assert.rejects(device.startStream(user("a"), fakeStream(), channel("99")), /not found/);

    assert.strictEqual(device.isFree, true);
    assert.deepStrictEqual(dvb.calls, [["close"]]);
  });

  it("reopens and retunes the same channel after a read error", async () => {
    const [device, dvb] = createDevice();
    const stream = fakeStream();
    const started = device.startStream(user("a"), stream, channel("27"));
    await dvb.resolveStart();
    await started;

    dvb.emit("error", Object.assign(new Error("read ENODEV"), { code: "ENODEV" }));
    await dvb.resolveStart();
    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["close"], ["start", 557142857]]);

    // コマンドのプロセスを起動し直した場合と同じく、ユーザーを残したまま配信を続ける
    assert.strictEqual(stream.ended, false);
    assert.deepStrictEqual(device.users.map(u => u.id), ["a"]);
    assert.strictEqual(device.channel.channel, "27");

    // 選局し直した後に再び失敗した場合も、同じく選局し直す
    dvb.emit("error", Object.assign(new Error("read ENODEV"), { code: "ENODEV" }));
    await dvb.resolveStart();
    assert.deepStrictEqual(dvb.calls.slice(3), [["close"], ["start", 557142857]]);
    assert.strictEqual(stream.ended, false);
  });

  it("releases once when stopped while reopening after a read error", async () => {
    const [device, dvb] = createDevice();
    const stream = fakeStream();
    const started = device.startStream(user("a"), stream, channel("27"));
    await dvb.resolveStart();
    await started;

    let released = 0;
    device.on("release", () => ++released);
    dvb.emit("error", Object.assign(new Error("read ENODEV"), { code: "ENODEV" }));
    await device.kill();
    await flush();

    assert.strictEqual(released, 1);
    assert.strictEqual(stream.ended, true);
    assert.strictEqual(device.isFree, true);
    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["close"], ["stopStream"]]);
  });

  it("uses the command when the channels file can not be used", () => {
    const badConfPath = path.join(dir, "bad.conf");
    fs.writeFileSync(badConfPath, "[27]\n\tDELIVERY_SYSTEM = ISDBT\n\tMODULATION = QAM/AUTO\n");

    for (const conf of [badConfPath, path.join(dir, "missing.conf")]) {
      const device = new TunerDevice(9, { name: "dvb", types: ["GR"], command: `dvbv5-zap -a 9 -c ${conf} -P <channel>` });
      assert.strictEqual(device._dvb, null, conf);
    }
  });
});
