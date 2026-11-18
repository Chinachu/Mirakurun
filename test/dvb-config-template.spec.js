/*
   Copyright 2026 The Mirakurun Developers.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
require("reflect-metadata");
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const feature = fs.existsSync(path.join(__dirname, "../src/Mirakurun"));
const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
const statusPath = require.resolve(prefix + "/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: {}
} } };
const logPath = require.resolve(prefix + (feature ? "/log" : "/event-log"));
const log = { info() {}, warn() {}, debug() {}, error() {} };
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: log };
const _ = require(prefix + "/_").default;
const TunerDevice = require(prefix + "/TunerDevice").default;
const Tuner = require(prefix + "/Tuner").default;
const Event = require(prefix + "/Event").default;
const zap = require(prefix + "/dvb/dvbv5-zap");
const { SYS } = require(prefix + "/dvb/constants");
const scan = require((feature ? "../lib/Mirakurun/api" : "../lib/server/api") + "/config/channels/scan");
function fixture(t, command, options = {}) {
    const previous = _.config; _.config = { server: {}, tuners: [] };
    t.after(() => { _.config = previous; });
    t.mock.method(Event, "emit", () => {});
    t.mock.method(log, "warn", () => {});
    const device = new TunerDevice(0, { name: "template probe", types: ["BS"], routes: ["SAT"], command, disableDvbDirect: true, ...options });
    const tuner = new Tuner(); tuner._devices = [device];
    t.after(async () => { if (device.close) { await device.close(); } else { device._clearEndStreamTimer(); clearTimeout(device._remoteRelTsRetryTimer); } });
    return { device, tuner };
}
for (const option of ["-c /conf/<type>.conf", "--channels=/conf/<channel>.conf", "-rc/conf/<frequency>.conf", "-c /conf/<route>/<type>.conf"]) {
    it(`[dvb-config-template] 解決できない-c変数をファイル名とみなさずBS名へfallbackする (${option})`, async t => {
        const command = `dvbv5-zap ${option} -P <channel>`;
        const f = fixture(t, command);
        assert.equal(zap.findDvbv5ZapChannelsConf(command.replace(/<route>/g, "sat")), null);
        assert.equal(await f.device.getDvbChannelStream("SAT", "BS01_0"), undefined);
        assert.equal(await f.device.getDvbChannelNames("SAT"), null);
        assert.deepEqual(await scan.getBsChannel(f.device, "SAT", "BS01_0"), { transponder: 1 });
        assert.deepEqual(await f.tuner.getDvbChannelNames("SAT", "BS"), []);
        assert.equal(log.warn.mock.callCount(), 0);
    });
}
it("[dvb-config-template] routeだけを解決した固定設定ファイルは従来どおり読み込む", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-template-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, "sat.conf"), "[BS01_0]\nDELIVERY_SYSTEM = ISDBS\nFREQUENCY = 1049480\nSTREAM_ID = 16400\n");
    const f = fixture(t, `dvbv5-zap -c "${directory}/<route>.conf" -P <channel>`);
    assert.deepEqual(await f.device.getDvbChannelNames("SAT"), ["BS01_0"]);
    assert.deepEqual(await f.device.getDvbChannelStream("SAT", "BS01_0"), { deliverySystem: SYS.ISDBS, frequency: 1049480, streamId: 16400 });
    assert.deepEqual(await scan.getBsChannel(f.device, "SAT", "BS01_0"), { transponder: 1, streamId: 16400 });
    assert.equal(log.warn.mock.callCount(), 0);
});
it("[dvb-config-template] 固定パスの読取失敗を未対応と偽らずBS名を推測しない", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-missing-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const missing = path.join(directory, "missing.conf");
    const f = fixture(t, `dvbv5-zap -c "${missing}" -P <channel>`);
    assert.equal(zap.findDvbv5ZapChannelsConf(f.device.config.command), missing);
    await assert.rejects(f.device.getDvbChannelStream("SAT", "BS01_0"), error => error.code === "ENOENT");
    assert.equal(await scan.getBsChannel(f.device, "SAT", "BS01_0"), null);
});

for (const disabled of [true, false]) {
    it(`[dvb-config-template] 直接操作を使えなくてもコマンドの周波数指定からBSを判定する (disabled=${disabled})`, async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-frequency-"));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        fs.writeFileSync(path.join(directory, "sat.conf"), "[BS01_0]\nDELIVERY_SYSTEM = ISDBS\nFREQUENCY = 1049480\nSTREAM_ID = 16400\n");
        let ffiLoads = 0;
        if (!disabled) {
            const Module = require("node:module"), load = Module._load;
            t.mock.method(Module, "_load", function (request, ...args) {
                if (request === "./dvb/DvbDevice") { ++ffiLoads; throw new Error("koffi unavailable"); }
                return load.call(this, request, ...args);
            });
        }
        const f = fixture(t, `dvbv5-zap -c "${directory}/<route>.conf" -P <channel>`, { disableDvbDirect: disabled });
        assert.equal(f.device._dvb, null, "実DVBデバイスを開かない経路を確認する");
        assert.equal(ffiLoads, disabled ? 0 : 1);
        assert.deepEqual(await f.device.getDvbChannelStream("SAT", "1049480"), { deliverySystem: SYS.ISDBS, frequency: 1049480, streamId: 16400 });
        assert.deepEqual(await scan.getBsChannel(f.device, "SAT", "1049480"), { transponder: 1, streamId: 16400 });
    });
}
for (const flags of ["-rP", "--record -P", "-P -o -", "-P --output=-"]) {
    it(`[dvb-config-template] ${flags} のコマンドでは周波数を名前の代わりに使わない`, async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-record-"));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const confPath = path.join(directory, "sat.conf");
        fs.writeFileSync(confPath, "[BS01_0]\nDELIVERY_SYSTEM = ISDBS\nFREQUENCY = 1049480\nSTREAM_ID = 16400\n");
        const f = fixture(t, `dvbv5-zap -c "${confPath}" ${flags} <channel>`);
        assert.equal(await f.device.getDvbChannelStream("SAT", "1049480"), null);
        assert.equal(await scan.getBsChannel(f.device, "SAT", "1049480"), null);
        assert.deepEqual(await scan.getBsChannel(f.device, "SAT", "BS01_0"), { transponder: 1, streamId: 16400 });
    });
}
it("[dvb-config-template] 周波数がBS帯でも設定のdelivery systemを優先する", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-cable-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const confPath = path.join(directory, "sat.conf");
    fs.writeFileSync(confPath, "[C19]\nDELIVERY_SYSTEM = DVBC/ANNEX_A\nFREQUENCY = 1049480\nMODULATION = QAM/64\n");
    const f = fixture(t, `dvbv5-zap -c "${confPath}" -P <channel>`);
    assert.equal((await f.device.getDvbChannelStream("SAT", "1049480"))?.deliverySystem, SYS.DVBC_ANNEX_A);
    assert.equal(await scan.getBsChannel(f.device, "SAT", "1049480"), null);
});
it("[dvb-config-template] 直接操作に未対応のオプションでも名前による設定読込みを維持する", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-option-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const confPath = path.join(directory, "sat.conf");
    fs.writeFileSync(confPath, "[BS01_0]\nDELIVERY_SYSTEM = ISDBS\nFREQUENCY = 1049480\nSTREAM_ID = 16400\n");
    const f = fixture(t, `dvbv5-zap -c "${confPath}" -P --unsupported-option <channel>`);
    assert.deepEqual(await scan.getBsChannel(f.device, "SAT", "BS01_0"), { transponder: 1, streamId: 16400 });
    assert.equal(log.warn.mock.callCount(), 0);
});

for (const dvbs2First of [true, false]) {
    it(`[dvb-config-template] DVB-S2混在設定でもISDB-SのBS判定とスキャン省略を維持する (dvbs2First=${dvbs2First})`, async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-mixed-"));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const confPath = path.join(directory, "sat.conf");
        const bs = "[custom-bs]\nDELIVERY_SYSTEM = ISDBS\nFREQUENCY = 1049480\nSTREAM_ID = 16400\nVCHANNEL = 101\n";
        // 直接操作では使わない項目がDELIVERY_SYSTEMの前後にあっても、スキャン用の情報は読める。
        const dvbs2 = "[custom-uhd]\nROLLOFF = 0.35\nFREQUENCY = 1049480\nDELIVERY_SYSTEM = DVBS2\nPILOT = AUTO\nVCHANNEL = 102\n";
        fs.writeFileSync(confPath, dvbs2First ? dvbs2 + bs : bs + dvbs2);
        const f = fixture(t, `dvbv5-zap -c "${confPath}" -P <channel>`);
        assert.deepEqual(await f.device.getDvbChannelNames("SAT"), dvbs2First ? ["custom-uhd", "custom-bs"] : ["custom-bs", "custom-uhd"]);
        const bsChannel = await scan.getBsChannel(f.device, "SAT", "custom-bs");
        assert.deepEqual(bsChannel, { transponder: 1, streamId: 16400 });
        assert.deepEqual(await f.device.getDvbChannelStream("SAT", "101"), { deliverySystem: SYS.ISDBS, frequency: 1049480, streamId: 16400 });
        assert.deepEqual(await scan.getBsChannel(f.device, "SAT", "CUSTOM-BS"), bsChannel);
        assert.equal(await scan.getBsChannel(f.device, "SAT", "custom-uhd"), null);
        assert.equal(await scan.getBsChannel(f.device, "SAT", "102"), null);
        assert.equal((await f.device.getDvbChannelStream("SAT", "1049480"))?.deliverySystem, dvbs2First ? SYS.DVBS2 : SYS.ISDBS);
        assert.equal(await f.device.getDvbChannelStream("SAT", "missing"), null);
        assert.equal(scan.isAbsentBsChannel(new Map([[1, [16400]]]), bsChannel, false, new Set()), false);
        assert.equal(scan.isAbsentBsChannel(new Map([[1, [16401]]]), bsChannel, false, new Set()), true);
        // スキャンのキャッシュを直接選局へ流用せず、混在設定ではコマンドへ切り替える。
        const conf = require(prefix + "/dvb/DvbChannelConf");
        assert.throws(() => conf.loadChannelsConf(confPath), /unsupported (property|DELIVERY_SYSTEM)/);
        await assert.rejects(conf.readChannelsConf(confPath), /unsupported (property|DELIVERY_SYSTEM)/);
        f.device._initDvb();
        assert.equal(f.device._dvb, null);
        assert.equal(log.warn.mock.callCount(), 1);
    });
}
for (const invalid of [
    "FREQUENCY = invalid",
    "FREQUENCY = 4294967296",
    "FREQUENCY = 1049480\nFREQUENCY = 1049480",
    "FREQUENCY = 1049480\nSTREAM_ID = invalid",
    "FREQUENCY = 1049480\nUNKNOWN_PROPERTY = 1"
]) {
    it(`[dvb-config-template] DVB-S2混在時もISDB-Sの不正な設定をBSとして推測しない (${invalid.replaceAll("\n", ", ")})`, async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-dvb-mixed-invalid-"));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const confPath = path.join(directory, "sat.conf");
        fs.writeFileSync(confPath, `[BS01_0]\nDELIVERY_SYSTEM = ISDBS\n${invalid}\n[uhd]\nDELIVERY_SYSTEM = DVBS2\nFREQUENCY = 1049480\n`);
        const f = fixture(t, `dvbv5-zap -c "${confPath}" -P <channel>`);
        await assert.rejects(f.device.getDvbChannelStream("SAT", "BS01_0"));
        assert.equal(await scan.getBsChannel(f.device, "SAT", "BS01_0"), null);
    });
}
