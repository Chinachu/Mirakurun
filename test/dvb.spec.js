const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { DTV, SYS, SEC_VOLTAGE, SEC_TONE, SEC_MINI, LNA_AUTO } = require("../lib/Mirakurun/dvb/constants");
const conf = require("../lib/Mirakurun/dvb/DvbChannelConf");
const sat = require("../lib/Mirakurun/dvb/DvbSat");

// x64 と arm64 は構造体の大きさと ioctl 番号が同じ (それぞれ gcc で確認した)
const isVerifiedArch = ["x64", "arm64"].includes(process.arch);
// linux-dvb.ts は ioctl 番号の形式が異なるアーキテクチャでは読み込めない
const isSupportedArch = (() => {
  try {
    require("../lib/Mirakurun/dvb/linux-dvb");
    return true;
  } catch {
    return false;
  }
})();

describe("[dvb.spec] DvbChannelConf.ts: parseDvbv5ChannelsConf()", () => {
  it("parses sections and properties", () => {
    const channels = conf.parseDvbv5ChannelsConf([
      "# comment",
      "[27]",
      "\tDELIVERY_SYSTEM = ISDBT",
      "\tFREQUENCY = 557142857",
      "\tBANDWIDTH_HZ = 6000000",
      "",
      "[BS01_0]",
      "\tDELIVERY_SYSTEM = ISDBS",
      "\tFREQUENCY = 1049480",
      "\tSTREAM_ID = 16400"
    ].join("\n"));

    assert.deepStrictEqual(channels.get("27"), {
      deliverySystem: SYS.ISDBT,
      properties: [[DTV.FREQUENCY, 557142857], [DTV.BANDWIDTH_HZ, 6000000]]
    });
    assert.deepStrictEqual(channels.get("BS01_0"), {
      deliverySystem: SYS.ISDBS,
      properties: [[DTV.FREQUENCY, 1049480], [DTV.STREAM_ID, 16400]]
    });
  });

  it("rejects unsupported properties", () => {
    assert.throws(
      () => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBT\n MODULATION = QAM/64\n"),
      /unsupported property MODULATION/
    );
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = DVBT\n"), /unsupported DELIVERY_SYSTEM/);
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = constructor\n"), /unsupported DELIVERY_SYSTEM/);
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBS\n LNB = UNKNOWN\n"), /unsupported property LNB/);
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBS\n POLARIZATION = X\n"), /unsupported property POLARIZATION/);
  });

  it("parses LNB settings", () => {
    const channels = conf.parseDvbv5ChannelsConf([
      "[BS01_0]",
      "\tDELIVERY_SYSTEM = ISDBS",
      "\tFREQUENCY = 11727480",
      "\tLNB = 110bs",
      "\tPOLARIZATION = RIGHT",
      "\tSAT_NUMBER = 1",
      "\tDISEQC_WAIT = 100",
      "\tFREQ_BPF = 1210"
    ].join("\n"));

    assert.deepStrictEqual(channels.get("BS01_0"), {
      deliverySystem: SYS.ISDBS,
      properties: [[DTV.FREQUENCY, 11727480]],
      lnb: sat.findLnb("110BS"),
      polarization: sat.POLARIZATION.R,
      satNumber: 1
    });
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n FREQUENCY = 1\n"), /DELIVERY_SYSTEM is missing/);
  });

  it("reloads the file only when it is modified", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvbconf-"));
    try {
      const file = path.join(dir, "channels.conf");
      fs.writeFileSync(file, "[27]\n DELIVERY_SYSTEM = ISDBT\n FREQUENCY = 557142857\n");
      const channels = conf.loadChannelsConf(file);
      assert.strictEqual(conf.loadChannelsConf(file), channels);

      fs.writeFileSync(file, "[27]\n DELIVERY_SYSTEM = ISDBT\n MODULATION = QAM/AUTO\n");
      fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
      assert.throws(() => conf.loadChannelsConf(file), /unsupported property MODULATION/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds the channel in the same way as dvbv5-zap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvbconf-"));
    try {
      const file = path.join(dir, "channels.conf");
      fs.writeFileSync(file, [
        "[BS01_0]", " DELIVERY_SYSTEM = ISDBS", " FREQUENCY = 1049480",
        "[BS01_0]", " DELIVERY_SYSTEM = ISDBS", " FREQUENCY = 1",
        "[bs03_0]", " DELIVERY_SYSTEM = ISDBS", " FREQUENCY = 1087840",
        "[BS03_0]", " DELIVERY_SYSTEM = ISDBS", " FREQUENCY = 2"
      ].join("\n"));

      // 同じ名前は先のもの、見つからなければ大文字と小文字を区別しない
      assert.deepStrictEqual(conf.getChannelParams("BS", "BS01_0", file).properties, [[DTV.FREQUENCY, 1049480]]);
      assert.deepStrictEqual(conf.getChannelParams("BS", "bs01_0", file).properties, [[DTV.FREQUENCY, 1049480]]);
      assert.deepStrictEqual(conf.getChannelParams("BS", "BS03_0", file).properties, [[DTV.FREQUENCY, 2]]);
      assert.deepStrictEqual(conf.getChannelParams("BS", "Bs03_0", file).properties, [[DTV.FREQUENCY, 1087840]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not support SKY", () => {
    assert.throws(() => conf.getDefaultConfPath("SKY"), /not supported/);
  });

  const confExists = fs.existsSync(conf.getDefaultConfPath("GR"));
  it("loads dvbconf-for-isdb", { skip: !confExists && "config/dvbconf-for-isdb is not checked out" }, () => {
    assert.deepStrictEqual(conf.getChannelParams("GR", "27").properties, [[DTV.FREQUENCY, 557142857], [DTV.BANDWIDTH_HZ, 6000000]]);
    assert.strictEqual(conf.getChannelParams("BS", "BS01_0").deliverySystem, SYS.ISDBS);
    assert.throws(() => conf.getChannelParams("GR", "99"), /not found/);
  });
});

describe("[dvb.spec] linux-dvb.ts", { skip: !isVerifiedArch && "x64 / arm64 only" }, () => {
  // gcc と uapi のヘッダーで確認した値
  it("matches the uapi struct sizes", () => {
    const { sizes } = require("../lib/Mirakurun/dvb/linux-dvb");
    assert.deepStrictEqual(sizes, {
      dtvProperty: 76,
      dtvProperties: 16,
      dvbDiseqcMasterCmd: 7,
      dmxPesFilterParams: 20
    });
  });

  it("matches the uapi ioctl numbers", () => {
    const { requests } = require("../lib/Mirakurun/dvb/linux-dvb");
    assert.deepStrictEqual(requests, {
      FE_SET_PROPERTY: 0x40106f52,
      FE_GET_PROPERTY: 0x80106f53,
      FE_DISEQC_SEND_MASTER_CMD: 0x40076f3f,
      FE_DISEQC_SEND_BURST: 0x6f41,
      FE_SET_TONE: 0x6f42,
      FE_SET_VOLTAGE: 0x6f43,
      DMX_SET_PES_FILTER: 0x40146f2c,
      DMX_SET_BUFFER_SIZE: 0x6f2d
    });
  });

  it("rejects with errno", async () => {
    const linuxDvb = require("../lib/Mirakurun/dvb/linux-dvb");
    const fd = fs.openSync("/dev/null", "r");
    try {
      await assert.rejects(linuxDvb.getDeliverySystem(fd), { code: "ENOTTY", syscall: "ioctl" });
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("[dvb.spec] DvbSat.ts: getSatTuning()", () => {
  const { getSatTuning, findLnb, POLARIZATION } = sat;
  const options = (lnb, extra = {}) => ({ lnb: findLnb(lnb), satNumber: -1, diseqcWait: 0, freqBpf: 0, ...extra });

  it("does nothing without LNBf", () => {
    assert.strictEqual(getSatTuning(SYS.ISDBS, 1049480, POLARIZATION.OFF, { ...options("110BS"), lnb: null }), null);
  });

  it("converts the frequency and powers the LNB with 18V for ISDB-S (110BS)", () => {
    assert.deepStrictEqual(getSatTuning(SYS.ISDBS, 11727480, POLARIZATION.OFF, options("110bs")), {
      frequency: 1049480,
      sec: { voltage: SEC_VOLTAGE.V18, tone: false, diseqc: null }
    });
    // 局部発振器が 1 つの LNBf は範囲を確かめないため、中間周波数を指定すると frontend が受け付けない値になる
    assert.strictEqual(getSatTuning(SYS.ISDBS, 1049480, POLARIZATION.OFF, options("110BS")).frequency, (1049480 - 10678000) >>> 0);
  });

  it("selects the band and polarization by voltage and tone (Universal)", () => {
    assert.deepStrictEqual(getSatTuning(SYS.DVBS, 11000000, POLARIZATION.H, options("UNIVERSAL")), {
      frequency: 1250000,
      sec: { voltage: SEC_VOLTAGE.V18, tone: false, diseqc: null }
    });
    assert.deepStrictEqual(getSatTuning(SYS.DVBS, 12000000, POLARIZATION.V, options("UNIVERSAL")), {
      frequency: 1400000,
      sec: { voltage: SEC_VOLTAGE.V13, tone: true, diseqc: null }
    });
    assert.strictEqual(getSatTuning(SYS.DVBS, 13000000, POLARIZATION.H, options("UNIVERSAL")), null);
  });

  it("sends DiSEqC commands with the satellite number", () => {
    assert.deepStrictEqual(getSatTuning(SYS.DVBS, 12000000, POLARIZATION.H, options("UNIVERSAL", { satNumber: 1, diseqcWait: 100 })).sec, {
      voltage: SEC_VOLTAGE.V18,
      tone: true,
      diseqc: { command: [0xE0, 0x10, 0x38, 0xF7], burst: SEC_MINI.B, wait: 100 }
    });
    assert.deepStrictEqual(getSatTuning(SYS.DVBS, 11000000, POLARIZATION.V, options("UNIVERSAL", { satNumber: 2 })).sec, {
      voltage: SEC_VOLTAGE.V13,
      tone: false,
      diseqc: { command: [0xE0, 0x10, 0x38, 0xF8], burst: null, wait: 0 }
    });
  });

  it("uses SCR/Unicable only with DiSEqC", () => {
    const scr = getSatTuning(SYS.DVBS, 11000000, POLARIZATION.H, options("UNIVERSAL", { freqBpf: 1210 }));
    assert.strictEqual(scr.sec, null);
    assert.strictEqual(scr.frequency, (11000000 - 12212000) >>> 0);
    assert.deepStrictEqual(getSatTuning(SYS.DVBS, 11000000, POLARIZATION.H, options("UNIVERSAL", { freqBpf: 1210, satNumber: 0 })).sec.diseqc, {
      command: [0xE0, 0x10, 0x5A, 0x06, 0x8F],
      burst: SEC_MINI.A,
      wait: 0
    });
  });

  it("selects the local oscillator by polarization (bandstacking)", () => {
    assert.deepStrictEqual(getSatTuning(SYS.DVBS, 12500000, POLARIZATION.H, options("DISHPRO")), {
      frequency: (12500000 - 14350000) >>> 0,
      sec: { voltage: SEC_VOLTAGE.V13, tone: false, diseqc: null }
    });
    assert.strictEqual(getSatTuning(SYS.DVBS, 12500000, POLARIZATION.L, options("DISHPRO")), null);
  });
});

describe("[dvb.spec] DvbDevice.ts: LNB", { skip: !isSupportedArch && `${process.arch} is not supported` }, () => {
  const linuxDvb = require("../lib/Mirakurun/dvb/linux-dvb");
  const DvbDevice = require("../lib/Mirakurun/dvb/DvbDevice").default;
  const names = ["setProperties", "setVoltage", "setTone", "sendDiseqcCommand", "sendDiseqcBurst"];
  const originals = {};
  let calls;

  before(() => {
    for (const name of names) {
      originals[name] = linuxDvb[name];
      linuxDvb[name] = async (fd, ...args) => {
        calls.push([name, ...args]);
      };
    }
  });
  after(() => Object.assign(linuxDvb, originals));

  function openDevice(options, deliverySystem) {
    calls = [];
    const device = new DvbDevice({ adapter: 0, ...options });
    device._frontendFd = fs.openSync("/dev/null", "r");
    device._deliverySystem = deliverySystem;
    return device;
  }

  it("sets the voltage and tone in the same order as dvbv5-zap", async () => {
    const device = openDevice({ lnb: sat.findLnb("UNIVERSAL"), satNumber: 0, lna: 1 }, SYS.ISDBT);
    await device._tune({ deliverySystem: SYS.DVBS, properties: [[DTV.FREQUENCY, 12000000], [DTV.SYMBOL_RATE, 27500000]], polarization: sat.POLARIZATION.V });

    assert.deepStrictEqual(calls, [
      ["setProperties", [[DTV.DELIVERY_SYSTEM, SYS.DVBS]]],
      ["setProperties", [[DTV.LNA, 1]]],
      ["setVoltage", SEC_VOLTAGE.V13],
      ["setTone", SEC_TONE.OFF],
      ["sendDiseqcCommand", [0xE0, 0x10, 0x38, 0xF1]],
      ["sendDiseqcBurst", SEC_MINI.A],
      ["setTone", SEC_TONE.ON],
      ["setProperties", [[DTV.CLEAR, 0], [DTV.DELIVERY_SYSTEM, SYS.DVBS], [DTV.FREQUENCY, 1400000], [DTV.SYMBOL_RATE, 27500000], [DTV.TUNE, 0]]]
    ]);

    // 衛星から地上に切り替える場合と、衛星で閉じる場合は給電を止める
    calls = [];
    await device._tune({ deliverySystem: SYS.ISDBT, properties: [[DTV.FREQUENCY, 557142857]] });
    await device.close();
    assert.deepStrictEqual(calls, [
      ["setVoltage", SEC_VOLTAGE.OFF],
      ["setProperties", [[DTV.DELIVERY_SYSTEM, SYS.ISDBT]]],
      ["setProperties", [[DTV.LNA, 1]]],
      ["setProperties", [[DTV.CLEAR, 0], [DTV.DELIVERY_SYSTEM, SYS.ISDBT], [DTV.FREQUENCY, 557142857], [DTV.TUNE, 0]]]
    ]);
  });

  it("uses LNB settings of the channel and turns off the LNB power on close", async () => {
    const device = openDevice({}, SYS.ISDBS);
    await device._tune({ deliverySystem: SYS.ISDBS, properties: [[DTV.FREQUENCY, 11727480], [DTV.STREAM_ID, 16400]], lnb: sat.findLnb("110BS") });
    await device.close();

    assert.deepStrictEqual(calls, [
      ["setVoltage", SEC_VOLTAGE.V18],
      ["setTone", SEC_TONE.OFF],
      ["setTone", SEC_TONE.OFF],
      ["setProperties", [[DTV.CLEAR, 0], [DTV.DELIVERY_SYSTEM, SYS.ISDBS], [DTV.FREQUENCY, 1049480], [DTV.STREAM_ID, 16400], [DTV.TUNE, 0]]],
      ["setVoltage", SEC_VOLTAGE.OFF]
    ]);
  });

  it("sets LNA on every tuning even after it fails (same as dvbv5-zap)", async () => {
    const log = require("../lib/Mirakurun/log");
    const warn = log.warn;
    const setProperties = linuxDvb.setProperties;
    log.warn = () => {};
    linuxDvb.setProperties = async (fd, props) => {
      calls.push(["setProperties", props]);
      if (props[0][0] === DTV.LNA) {
        throw Object.assign(new Error("ioctl EINVAL"), { code: "EINVAL" });
      }
    };

    const device = openDevice({ lna: 1 }, SYS.ISDBT);
    try {
      const params = { deliverySystem: SYS.ISDBT, properties: [[DTV.FREQUENCY, 557142857]] };
      await device._tune(params);
      await device._tune(params);
    } finally {
      log.warn = warn;
      linuxDvb.setProperties = setProperties;
      await device.close();
    }

    assert.strictEqual(calls.filter(([name, props]) => name === "setProperties" && props[0][0] === DTV.LNA).length, 2);
  });

  it("does not control the LNB without LNBf (same as dvbv5-zap)", async () => {
    const device = openDevice({}, SYS.ISDBS);
    await device._tune({ deliverySystem: SYS.ISDBS, properties: [[DTV.FREQUENCY, 1049480], [DTV.STREAM_ID, 16400]] });
    await device.close();

    assert.deepStrictEqual(calls, [
      ["setProperties", [[DTV.CLEAR, 0], [DTV.DELIVERY_SYSTEM, SYS.ISDBS], [DTV.FREQUENCY, 1049480], [DTV.STREAM_ID, 16400], [DTV.TUNE, 0]]],
      // libdvbv5 と同じく、衛星の伝送方式で閉じる場合は給電を止める
      ["setVoltage", SEC_VOLTAGE.OFF]
    ]);
  });
});

describe("[dvb.spec] DvbDevice.ts: reading", { skip: !isSupportedArch && `${process.arch} is not supported` }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a nonblocking device until stopped", async () => {
    const log = require("../lib/Mirakurun/log");
    log.warn = () => {};
    const DvbDevice = require("../lib/Mirakurun/dvb/DvbDevice").default;

    // dvr の代わりに FIFO を使う (書き込み側が開いていて空の間は EAGAIN になる)
    const fifo = path.join(dir, "dvr0");
    execFileSync("mkfifo", [fifo]);
    const readFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const writeFd = fs.openSync(fifo, fs.constants.O_WRONLY);

    const device = new DvbDevice({ adapter: 0 });
    const chunks = [];
    device.on("data", chunk => chunks.push(chunk));
    device._startReading(readFd);

    const packets = Buffer.alloc(188 * 3, 0x47);
    fs.writeSync(writeFd, packets.subarray(0, 188));
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.writeSync(writeFd, packets.subarray(188));
    await new Promise(resolve => setTimeout(resolve, 50));

    await device._stopReading();
    fs.closeSync(writeFd);

    assert.ok(chunks.length >= 2);
    assert.deepStrictEqual(Buffer.concat(chunks), packets);
    assert.strictEqual(device.isStreaming, false);
  });
});

describe("[dvb.spec] dvbv5-zap.ts: parseDvbv5ZapCommand()", () => {
  const { parseDvbv5ZapCommand } = require("../lib/Mirakurun/dvb/dvbv5-zap");
  const conf = path.resolve("./config/dvbconf-for-isdb/conf/dvbv5_channels_isdbs.conf");
  const noSat = { lnb: null, satNumber: -1, diseqcWait: 0, freqBpf: 0, lna: LNA_AUTO };

  it("accepts LNB, DiSEqC and LNA options", () => {
    const options = parseDvbv5ZapCommand("dvbv5-zap -a 0 -c ch.conf -P -l 110bs -S 1 -W 100 -U 1210 -w on <channel>");
    assert.strictEqual(options.lnb, sat.findLnb("110BS"));
    assert.strictEqual(options.satNumber, 1);
    assert.strictEqual(options.diseqcWait, 100);
    assert.strictEqual(options.freqBpf, 1210);
    assert.strictEqual(options.lna, 1);

    for (const [value, lna] of [["off", 0], ["auto", LNA_AUTO], ["0", 0], ["2", 1], ["-1", LNA_AUTO]]) {
      assert.strictEqual(parseDvbv5ZapCommand(`dvbv5-zap -c ch.conf -P --lna=${value} <channel>`).lna, lna, value);
    }
  });

  it("parses the command generated by the tuner detection", () => {
    assert.deepStrictEqual(
      parseDvbv5ZapCommand("dvbv5-zap -a 2 -c ./config/dvbconf-for-isdb/conf/dvbv5_channels_isdbs.conf -r -P <channel>", "/dev/dvb/adapter2/dvr0"),
      { adapter: 2, frontend: 0, demux: 0, dvr: 0, channelsConfPath: conf, ...noSat }
    );
  });

  it("accepts output to stdout, long options, clustered flags and attached values", () => {
    assert.deepStrictEqual(
      parseDvbv5ZapCommand("/usr/bin/dvbv5-zap --adapter=3 -f1 -d 1 --channels ./config/dvbconf-for-isdb/conf/dvbv5_channels_isdbs.conf -sPo - -I dvbv5 <channel>"),
      { adapter: 3, frontend: 1, demux: 1, dvr: 1, channelsConfPath: conf, ...noSat }
    );
  });

  it("returns null for other commands", () => {
    assert.strictEqual(parseDvbv5ZapCommand("recpt1 --device /dev/pt3video2 <channel> - -"), null);
  });

  it("rejects options that change tuning or output", () => {
    const base = "dvbv5-zap -a 0 -c ch.conf -P";
    for (const [command, message] of [
      [`${base} -t 10 <channel>`, /unsupported option `-t`/],
      [`${base} -l UNKNOWN <channel>`, /unknown LNBf `UNKNOWN`/],
      [`${base} -S x <channel>`, /invalid value of `-S x`/],
      [`${base} -w x <channel>`, /invalid value of `-w x`/],
      [`${base} --lnbf=15 <channel>`, /unknown LNBf `15`/],
      [`${base} -o out.ts <channel>`, /output to file/],
      [`${base} -I ZAP <channel>`, /unsupported input format/],
      [`${base} <channel> <satellite>`, /only `<channel>`/],
      [`${base} 27`, /only `<channel>`/],
      ["dvbv5-zap -a 0 -c ch.conf -r <channel>", /`-P` is required/],
      ["dvbv5-zap -a 0 -P <channel>", /`-c` is required/],
      ["dvbv5-zap -a <adapter> -c ch.conf -P <channel>", /template variable/],
      ["dvbv5-zap -a x -c ch.conf -P <channel>", /invalid value of `-a x`/],
      ["dvbv5-zap -c ch.conf -P <channel> -a", /missing value of `-a`/]
    ]) {
      assert.throws(() => parseDvbv5ZapCommand(command), message, command);
    }
  });

  it("rejects dvbDevicePath of another device", () => {
    assert.throws(
      () => parseDvbv5ZapCommand("dvbv5-zap -a 1 -c ch.conf -r -P <channel>", "/dev/dvb/adapter0/dvr0"),
      /does not match/
    );
    assert.strictEqual(parseDvbv5ZapCommand("dvbv5-zap -a 1 -d 1 -c ch.conf -r -P <channel>", "/dev/dvb/adapter1/../adapter1/dvr1").dvr, 1);
  });
});
