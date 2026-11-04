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

  it("rejects channels that libdvbv5 would tune differently", () => {
    // 同じ項目の重複 (libdvbv5 は項目によって先の値と後の値のどちらかを使う)
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBS\n FREQUENCY = 1\n FREQUENCY = 2\n"), /duplicate property FREQUENCY/);
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBS\n DELIVERY_SYSTEM = ISDBT\n FREQUENCY = 1\n"), /duplicate property DELIVERY_SYSTEM/);
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBS\n"), /FREQUENCY is missing/);
    // libdvbv5 は 32 ビットに収まらない値を切り詰める
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBS\n FREQUENCY = 4294967296\n"), /unsupported property FREQUENCY/);
    // libdvbv5 は `=` の前の最後の 1 文字を消すため、`=` の前に空白がないとキーが変わる
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBS\n FREQUENCY=1049480\n"), /invalid line/);
    // libdvbv5 は値の末尾の空白と CR を除かない
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBS\n FREQUENCY = 1049480\n VCHANNEL = 101 \n"), /invalid value of VCHANNEL/);
    assert.throws(() => conf.parseDvbv5ChannelsConf("[1]\r\n DELIVERY_SYSTEM = ISDBS\r\n FREQUENCY = 1049480\r\n"), /invalid value of DELIVERY_SYSTEM/);
    // 帯域幅がなければ、libdvbv5 と同じく既定値で選局する
    assert.deepStrictEqual(conf.parseDvbv5ChannelsConf("[1]\n DELIVERY_SYSTEM = ISDBT\n FREQUENCY = 557142857\n").get("1").properties, [[DTV.FREQUENCY, 557142857]]);
    // libdvbv5 は空の名前をエラーにする
    assert.throws(() => conf.parseDvbv5ChannelsConf("[]\n DELIVERY_SYSTEM = ISDBS\n FREQUENCY = 1\n"), /invalid line/);
  });

  it("finds the channel by VCHANNEL and frequency in the same way as dvbv5-zap", () => {
    const channels = conf.parseDvbv5ChannelsConf([
      "[CHANNEL]", " DELIVERY_SYSTEM = ISDBS", " FREQUENCY = 1049480", " VCHANNEL = 101",
      "[ NHK BS1]x", " DELIVERY_SYSTEM = ISDBS", " FREQUENCY = 1087840",
      "[101]", " DELIVERY_SYSTEM = ISDBS", " FREQUENCY = 1",
      "[2]", " DELIVERY_SYSTEM = ISDBS", " FREQUENCY = 2"
    ].join("\n"));

    // 名前か VCHANNEL が一致する最初のチャンネル (`[CHANNEL]` は名前なし、名前は `]` まで、先頭の空白を除く)
    assert.deepStrictEqual(conf.findChannelParams(channels, "101", "ch.conf").properties, [[DTV.FREQUENCY, 1049480]]);
    assert.strictEqual(channels.get("CHANNEL"), undefined);
    assert.deepStrictEqual(conf.findChannelParams(channels, "nhk bs1", "ch.conf").properties, [[DTV.FREQUENCY, 1087840]]);

    // `-r` がない場合は、数値として読んだ値と周波数が一致するチャンネルも探す
    assert.throws(() => conf.findChannelParams(channels, "1087840", "ch.conf"), /not found/);
    assert.deepStrictEqual(conf.findChannelParams(channels, "1087840", "ch.conf", true).properties, [[DTV.FREQUENCY, 1087840]]);
    assert.deepStrictEqual(conf.findChannelParams(channels, " 1087840abc", "ch.conf", true).properties, [[DTV.FREQUENCY, 1087840]]);
    assert.deepStrictEqual(conf.findChannelParams(channels, "4294967298", "ch.conf", true).properties, [[DTV.FREQUENCY, 2]]);
    assert.throws(() => conf.findChannelParams(channels, "0", "ch.conf", true), /not found/);
    // strcasecmp() と isspace() と同じく、ASCII 以外の文字は区別し、空白として扱わない
    const wide = conf.parseDvbv5ChannelsConf("[ＮＨＫ]\n DELIVERY_SYSTEM = ISDBS\n FREQUENCY = 1049480\n");
    assert.throws(() => conf.findChannelParams(wide, "ｎｈｋ", "ch.conf"), /not found/);
    assert.throws(() => conf.findChannelParams(channels, "\u30001087840", "ch.conf", true), /not found/);
  });

  it("ignores the service information written by dvbv5-scan", () => {
    const channels = conf.parseDvbv5ChannelsConf([
      "[NHK]",
      "\tSERVICE_ID = 1024",
      "\tVIDEO_PID = 273",
      "\tAUDIO_PID = 274 275",
      "\tPID_0d = 4096",
      "\tVCHANNEL = 1.1",
      "\tNETWORK_ID = 32736",
      "\tTRANSPORT_ID = 32736",
      "\tFREQUENCY = 557142857",
      "\tBANDWIDTH_HZ = 6000000",
      "\tDELIVERY_SYSTEM = ISDBT"
    ].join("\n"));

    assert.deepStrictEqual(channels.get("NHK"), {
      deliverySystem: SYS.ISDBT,
      properties: [[DTV.FREQUENCY, 557142857], [DTV.BANDWIDTH_HZ, 6000000]]
    });
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
      fs.writeFileSync(file, "[27]\n DELIVERY_SYSTEM = ISDBT\n FREQUENCY = 557142857\n BANDWIDTH_HZ = 6000000\n");
      const channels = conf.loadChannelsConf(file);
      assert.strictEqual(conf.loadChannelsConf(file), channels);

      fs.writeFileSync(file, "[27]\n DELIVERY_SYSTEM = ISDBT\n MODULATION = QAM/AUTO\n");
      fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
      assert.throws(() => conf.loadChannelsConf(file), /unsupported property MODULATION/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads the file replaced with the same modification time", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvbconf-"));
    try {
      const file = path.join(dir, "channels.conf");
      const mtime = new Date(Date.now() - 60000);
      fs.writeFileSync(file, "[27]\n DELIVERY_SYSTEM = ISDBT\n FREQUENCY = 557142857\n BANDWIDTH_HZ = 6000000\n");
      fs.utimesSync(file, mtime, mtime);
      assert.deepStrictEqual(conf.loadChannelsConf(file).get("27").properties, [[DTV.FREQUENCY, 557142857], [DTV.BANDWIDTH_HZ, 6000000]]);

      // `cp -p` と同じく、更新日時を保ったまま置き換える
      const replaced = path.join(dir, "replaced.conf");
      fs.writeFileSync(replaced, "[27]\n DELIVERY_SYSTEM = ISDBT\n FREQUENCY = 551142857\n BANDWIDTH_HZ = 6000000\n");
      fs.utimesSync(replaced, mtime, mtime);
      fs.renameSync(replaced, file);
      assert.deepStrictEqual(conf.loadChannelsConf(file).get("27").properties, [[DTV.FREQUENCY, 551142857], [DTV.BANDWIDTH_HZ, 6000000]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the file asynchronously with the same cache", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvbconf-"));
    try {
      const file = path.join(dir, "channels.conf");
      fs.writeFileSync(file, "[27]\n DELIVERY_SYSTEM = ISDBT\n FREQUENCY = 557142857\n BANDWIDTH_HZ = 6000000\n");
      const channels = await conf.readChannelsConf(file);
      assert.strictEqual(conf.loadChannelsConf(file), channels);
      assert.deepStrictEqual(conf.findChannelParams(channels, "27", file).properties, [[DTV.FREQUENCY, 557142857], [DTV.BANDWIDTH_HZ, 6000000]]);
      assert.throws(() => conf.findChannelParams(channels, "26", file), /not found/);

      fs.writeFileSync(file, "[27]\n DELIVERY_SYSTEM = ISDBT\n MODULATION = QAM/AUTO\n");
      fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
      await assert.rejects(conf.readChannelsConf(file), /unsupported property MODULATION/);
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
      const channels = conf.loadChannelsConf(file);
      assert.deepStrictEqual(conf.findChannelParams(channels, "BS01_0", file).properties, [[DTV.FREQUENCY, 1049480]]);
      assert.deepStrictEqual(conf.findChannelParams(channels, "bs01_0", file).properties, [[DTV.FREQUENCY, 1049480]]);
      assert.deepStrictEqual(conf.findChannelParams(channels, "BS03_0", file).properties, [[DTV.FREQUENCY, 2]]);
      assert.deepStrictEqual(conf.findChannelParams(channels, "Bs03_0", file).properties, [[DTV.FREQUENCY, 1087840]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const confDir = path.join(__dirname, "../config/dvbconf-for-isdb/conf");
  const isdbt = path.join(confDir, "dvbv5_channels_isdbt.conf");
  const isdbs = path.join(confDir, "dvbv5_channels_isdbs.conf");
  it("loads dvbconf-for-isdb", { skip: !fs.existsSync(isdbt) && "config/dvbconf-for-isdb is not checked out" }, () => {
    assert.deepStrictEqual(conf.findChannelParams(conf.loadChannelsConf(isdbt), "27", isdbt).properties, [[DTV.FREQUENCY, 557142857], [DTV.BANDWIDTH_HZ, 6000000]]);
    assert.strictEqual(conf.findChannelParams(conf.loadChannelsConf(isdbs), "BS01_0", isdbs).deliverySystem, SYS.ISDBS);
    assert.throws(() => conf.findChannelParams(conf.loadChannelsConf(isdbt), "99", isdbt), /not found/);
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
    assert.strictEqual(linuxDvb.getPendingIoctlCount(), 0);
  });

  it("releases the buffers when the call fails before the ioctl", async () => {
    const linuxDvb = require("../lib/Mirakurun/dvb/linux-dvb");
    // 整数に変換できない fd では、koffi が ioctl を呼ばずに例外を投げる
    await assert.rejects(linuxDvb.ioctl("bad", linuxDvb.requests.FE_GET_PROPERTY, Buffer.alloc(16), [Buffer.alloc(16)]));
    assert.strictEqual(linuxDvb.getPendingIoctlCount(), 0);
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

  // libdvbv5 (dvbv5-zap) が送る ISDB-T の項目 (dvb-v5-std.c の順と、dvb-file.c の dvbv5_default_value() の値)
  const isdbtProperties = (frequency, bandwidth) => [
    [DTV.FREQUENCY, frequency], [DTV.BANDWIDTH_HZ, bandwidth],
    [6 /* INVERSION */, 2 /* AUTO */], [38 /* GUARD_INTERVAL */, 4 /* AUTO */], [39 /* TRANSMISSION_MODE */, 2 /* AUTO */],
    [41 /* ISDBT_LAYER_ENABLED */, 7], [18 /* PARTIAL_RECEPTION */, 0], [19 /* SOUND_BROADCASTING */, 0],
    [20 /* SB_SUBCHANNEL_ID */, 0], [21 /* SB_SEGMENT_IDX */, 0], [22 /* SB_SEGMENT_COUNT */, 0],
    // 各階層の FEC (AUTO)、変調 (QAM_AUTO)、セグメント数 (-1)、時間インターリーブ (AUTO)
    [23, 9], [24, 6], [25, 0xFFFFFFFF], [26, 1],
    [27, 9], [28, 6], [29, 0xFFFFFFFF], [30, 1],
    [31, 9], [32, 6], [33, 0xFFFFFFFF], [34, 1],
    [DTV.DELIVERY_SYSTEM, SYS.ISDBT],
    [DTV.TUNE, 0]
  ];

  function openDevice(options, deliverySystem) {
    calls = [];
    const device = new DvbDevice({ adapter: 0, ...options });
    device._frontendFd = fs.openSync("/dev/null", "r");
    device._deliverySystem = deliverySystem;
    return device;
  }

  it("sets the voltage and tone in the same order as dvbv5-zap", async () => {
    const device = openDevice({ lnb: sat.findLnb("UNIVERSAL"), satNumber: 0, lna: 1 }, SYS.ISDBT);
    await device._tune({ deliverySystem: SYS.ISDBS, properties: [[DTV.FREQUENCY, 12000000]], polarization: sat.POLARIZATION.V });

    assert.deepStrictEqual(calls, [
      ["setProperties", [[DTV.DELIVERY_SYSTEM, SYS.ISDBS]]],
      ["setProperties", [[DTV.LNA, 1]]],
      ["setVoltage", SEC_VOLTAGE.V13],
      ["setTone", SEC_TONE.OFF],
      ["sendDiseqcCommand", [0xE0, 0x10, 0x38, 0xF1]],
      ["sendDiseqcBurst", SEC_MINI.A],
      ["setTone", SEC_TONE.ON],
      ["setProperties", [[DTV.FREQUENCY, 1400000], [DTV.STREAM_ID, 0], [DTV.DELIVERY_SYSTEM, SYS.ISDBS], [DTV.TUNE, 0]]]
    ]);

    // 衛星から地上に切り替える場合と、衛星で閉じる場合は給電を止める
    calls = [];
    await device._tune({ deliverySystem: SYS.ISDBT, properties: [[DTV.FREQUENCY, 557142857]] });
    await device.close();
    assert.deepStrictEqual(calls, [
      ["setVoltage", SEC_VOLTAGE.OFF],
      ["setProperties", [[DTV.DELIVERY_SYSTEM, SYS.ISDBT]]],
      ["setProperties", [[DTV.LNA, 1]]],
      ["setProperties", isdbtProperties(557142857, 0)]
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
      ["setProperties", [[DTV.FREQUENCY, 1049480], [DTV.STREAM_ID, 16400], [DTV.DELIVERY_SYSTEM, SYS.ISDBS], [DTV.TUNE, 0]]],
      ["setVoltage", SEC_VOLTAGE.OFF]
    ]);
  });

  it("sends the same properties as libdvbv5 without DTV_CLEAR", async () => {
    const device = openDevice({}, SYS.ISDBT);
    await device._tune({ deliverySystem: SYS.ISDBT, properties: [[DTV.FREQUENCY, 557142857], [DTV.BANDWIDTH_HZ, 6000000], [DTV.STREAM_ID, 1]] });
    // ISDB-S で STREAM_ID がない場合は、NO_STREAM_ID_FILTER ではなく libdvbv5 と同じく 0 を送る
    await device._tune({ deliverySystem: SYS.ISDBS, properties: [[DTV.FREQUENCY, 1049480]] });
    // 送る項目がわからない伝送方式では、何も設定せずに失敗する
    await assert.rejects(device._tune({ deliverySystem: SYS.DVBS, properties: [[DTV.FREQUENCY, 12000000]] }), /not supported/);
    await device.close();

    assert.deepStrictEqual(calls, [
      // ISDB-T では使わない STREAM_ID は、libdvbv5 と同じく送らない
      ["setProperties", isdbtProperties(557142857, 6000000)],
      ["setProperties", [[DTV.DELIVERY_SYSTEM, SYS.ISDBS]]],
      ["setProperties", [[DTV.FREQUENCY, 1049480], [DTV.STREAM_ID, 0], [DTV.DELIVERY_SYSTEM, SYS.ISDBS], [DTV.TUNE, 0]]],
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
      ["setProperties", [[DTV.FREQUENCY, 1049480], [DTV.STREAM_ID, 16400], [DTV.DELIVERY_SYSTEM, SYS.ISDBS], [DTV.TUNE, 0]]],
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
      { adapter: 2, frontend: 0, demux: 0, dvr: 0, channelsConfPath: conf, channelByFrequency: false, ...noSat }
    );
  });

  it("accepts output to stdout, long options, clustered flags and attached values", () => {
    assert.deepStrictEqual(
      parseDvbv5ZapCommand("/usr/bin/dvbv5-zap --adapter=3 -f1 -d 1 --channels ./config/dvbconf-for-isdb/conf/dvbv5_channels_isdbs.conf -sPo - -I dvbv5 <channel>"),
      { adapter: 3, frontend: 1, demux: 1, dvr: 1, channelsConfPath: conf, channelByFrequency: false, ...noSat }
    );
  });

  it("finds the channel by frequency only without -r and -o (same as dvbv5-zap)", () => {
    assert.strictEqual(parseDvbv5ZapCommand("dvbv5-zap -c ch.conf -P <channel>").channelByFrequency, true);
    assert.strictEqual(parseDvbv5ZapCommand("dvbv5-zap -c ch.conf -P -r <channel>").channelByFrequency, false);
    assert.strictEqual(parseDvbv5ZapCommand("dvbv5-zap -c ch.conf -P -o - <channel>").channelByFrequency, false);
  });

  it("does not accept numbers that dvbv5-zap reads differently", () => {
    // dvbv5-zap は strtoul(value, NULL, 0) で読むため、先頭の 0 は 8 進数になる
    for (const option of ["-a 010", "-a 08", "-f 01", "-d 0x1", "-S 010", "-W 0100", "-U 01210", "-w 08", "-a 4294967296"]) {
      assert.throws(() => parseDvbv5ZapCommand(`dvbv5-zap ${option} -c ch.conf -P <channel>`), /invalid value/, option);
    }
    assert.strictEqual(parseDvbv5ZapCommand("dvbv5-zap -a 0 -c ch.conf -P <channel>").adapter, 0);
    assert.strictEqual(parseDvbv5ZapCommand("dvbv5-zap -c ch.conf -P -S -1 <channel>").satNumber, -1);
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
