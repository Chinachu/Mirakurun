const { describe, it, before, after, beforeEach, afterEach, mock } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const child_process = require("child_process");

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
  // チャンネル設定ファイルを非同期で読んでから start() を呼ぶため、呼ばれるまで待つ (呼ばれない場合は止まらずに失敗する)
  // (設定ファイルはスレッドプールで読むため、回数ではなく時間で区切る。setTimeout は mock.timers で止めているため使わない)
  async waitStart() {
    const startedAt = performance.now();
    while (this.pendings.length === 0) {
      if (performance.now() - startedAt > 5000) {
        throw new Error("start() has not been called");
      }
      await flush();
    }
  }

  async resolveStart() {
    await this.waitStart();
    this.pendings.shift().resolve();
    await flush();
  }
  async rejectStart(err) {
    await this.waitStart();
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
    // 選局の途中 (start() の完了待ち) で横取りする
    await dvb.waitStart();

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
    await flush();
    // 失敗し続ける場合に待たずに選局し直し続けないよう、待ってから選局し直す
    mock.timers.tick(999);
    await flush();
    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["close"]]);
    mock.timers.tick(1);
    await dvb.resolveStart();
    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["close"], ["start", 557142857]]);

    // コマンドのプロセスを起動し直した場合と同じく、ユーザーを残したまま配信を続ける
    assert.strictEqual(stream.ended, false);
    assert.deepStrictEqual(device.users.map(u => u.id), ["a"]);
    assert.strictEqual(device.channel.channel, "27");

    // 選局し直した後に再び失敗した場合も、同じく選局し直す
    dvb.emit("error", Object.assign(new Error("read ENODEV"), { code: "ENODEV" }));
    await flush();
    mock.timers.tick(1000);
    await dvb.resolveStart();
    assert.deepStrictEqual(dvb.calls.slice(3), [["close"], ["start", 557142857]]);
    assert.strictEqual(stream.ended, false);

    // 選局し直した後は、他のユーザーも合流できる
    assert.strictEqual(device.isAvailable, true);
    await device.startStream(user("b"), fakeStream(), channel("27"));
    assert.deepStrictEqual(device.users.map(u => u.id), ["a", "b"]);
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

  it("does not retune when stopped while waiting to retune after a read error", async () => {
    const [device, dvb] = createDevice();
    const stream = fakeStream();
    const started = device.startStream(user("a"), stream, channel("27"));
    await dvb.resolveStart();
    await started;

    let released = 0;
    device.on("release", () => ++released);
    dvb.emit("error", Object.assign(new Error("read ENODEV"), { code: "ENODEV" }));
    await flush();
    await device.kill();
    mock.timers.tick(1000);
    await flush();

    assert.strictEqual(released, 1);
    assert.strictEqual(stream.ended, true);
    assert.strictEqual(device.isFree, true);
    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["close"], ["stopStream"]]);
  });

  it("runs the command only for the tuning when the channels file can not be used after start", async () => {
    const changedConfPath = path.join(dir, "changed.conf");
    fs.copyFileSync(confPath, changedConfPath);
    const [device, dvb] = createDevice();
    device._dvbChannelsConfPath = changedConfPath;
    const started = device.startStream(user("a"), fakeStream(), channel("27"));
    await dvb.resolveStart();
    await started;
    await device.kill();

    fs.writeFileSync(changedConfPath, "[27]\n\tDELIVERY_SYSTEM = ISDBT\n\tMODULATION = QAM/AUTO\n");
    fs.utimesSync(changedConfPath, new Date(), new Date(Date.now() + 1000));
    const processes = [];
    const spawn = mock.method(child_process, "spawn", (command, args) => {
      const p = new EventEmitter();
      p.pid = 1000 + processes.length;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      p.kill = () => p.emit("close", null, "SIGTERM");
      processes.push([command, ...args]);
      return p;
    });
    try {
      await device.startStream(user("b"), fakeStream(), channel("27"));
    } finally {
      spawn.mock.restore();
    }

    assert.deepStrictEqual(dvb.calls, [["start", 557142857], ["stopStream"], ["close"]]);
    assert.deepStrictEqual(processes, [["recpt1", "27", "-", "-"]]);
    assert.strictEqual(device.pid, 1000);

    // コマンドを止めた後に設定ファイルを直せば、次の選局は DVB デバイスを直接操作する
    const killed = device.kill();
    mock.timers.tick(100);
    await killed;
    fs.copyFileSync(confPath, changedConfPath);
    fs.utimesSync(changedConfPath, new Date(), new Date(Date.now() + 2000));
    const restarted = device.startStream(user("c"), fakeStream(), channel("26"));
    await dvb.resolveStart();
    await restarted;
    assert.deepStrictEqual(dvb.calls.slice(3), [["start", 551142857]]);
    assert.strictEqual(device.pid, null);
  });

  it("does not close the frontend of a newer tuning when reading the channels file fails late", async () => {
    const conf = require("../lib/Mirakurun/dvb/DvbChannelConf");
    const [device, dvb] = createDevice();
    let rejectFirst;
    let reads = 0;
    const read = mock.method(conf, "readChannelsConf", () => {
      if (++reads === 1) {
        return new Promise((resolve, reject) => rejectFirst = reject);
      }
      return Promise.resolve(conf.loadChannelsConf(confPath));
    });
    try {
      const low = device.startStream(user("low", 0), fakeStream(), channel("27"));
      await flush();

      // 設定を読む間に、優先度の高いユーザーが別のチャンネルを選局する
      const high = device.startStream(user("high", 1), fakeStream(), channel("26"));
      await dvb.resolveStart();
      await high;

      // 後から前の選局の読み込みが失敗しても、新しい選局の frontend は閉じない
      rejectFirst(new Error("unsupported property"));
      await low;
      await flush();
      assert.deepStrictEqual(dvb.calls, [["stopStream"], ["start", 551142857]]);
      assert.deepStrictEqual(device.users.map(u => u.id), ["high"]);
      assert.strictEqual(device.channel.channel, "26");
    } finally {
      read.mock.restore();
    }
  });

  it("ends the users who joined when the command can not be started instead", async () => {
    const brokenConfPath = path.join(dir, "broken.conf");
    fs.writeFileSync(brokenConfPath, "[27]\n\tDELIVERY_SYSTEM = ISDBT\n\tMODULATION = QAM/AUTO\n");
    const [device, dvb] = createDevice();
    device._dvbChannelsConfPath = brokenConfPath;
    const spawn = mock.method(child_process, "spawn", () => {
      throw new TypeError("The argument 'file' must be a string without null bytes");
    });
    try {
      const a = fakeStream();
      const b = fakeStream();
      const started = device.startStream(user("a"), a, channel("27"));
      // 設定ファイルを読む間に合流する
      const joined = device.startStream(user("b"), b, channel("27"));
      await assert.rejects(started, /null bytes/);
      await joined;
      await flush();

      assert.strictEqual(a.ended, true);
      assert.strictEqual(b.ended, true);
      assert.deepStrictEqual(device.users, []);
      assert.strictEqual(device.isFree, true);
      assert.strictEqual(device.command, null);
      assert.deepStrictEqual(dvb.calls, [["close"]]);
    } finally {
      spawn.mock.restore();
    }
  });

  it("releases once when the command fails to start (error and close)", async () => {
    const device = new TunerDevice(8, { name: "command", types: ["GR"], command: "recpt1 <channel> - -" });
    let spawned = 0;
    const spawn = mock.method(child_process, "spawn", () => {
      const p = new EventEmitter();
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      p.kill = () => {};
      ++spawned;
      // Node と同じく、起動できない場合は "error" の後に "close" も発生する
      process.nextTick(() => {
        p.emit("error", Object.assign(new Error("spawn recpt1 ENOENT"), { code: "ENOENT" }));
        p.emit("close", -2, null);
      });
      return p;
    });
    try {
      const stream = fakeStream();
      await device.startStream(user("a"), stream, channel("27"));
      await flush();
      mock.timers.tick(100);
      await flush();
      // 後処理が 2 回あると、1 回の失敗で 2 回起動し直す
      assert.strictEqual(spawned, 2);

      mock.timers.tick(100);
      await flush();
      assert.strictEqual(spawned, 3);
      // 3 回失敗すると故障として扱い、ユーザーを終了させる
      mock.timers.tick(100);
      await flush();
      assert.strictEqual(spawned, 3);
      assert.strictEqual(stream.ended, true);
      assert.strictEqual(device.isFault, true);
    } finally {
      spawn.mock.restore();
    }
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
