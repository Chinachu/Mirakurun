/*
   Copyright 2026 Mirakurun contributors

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
const { it } = require("node:test");
const assert = require("node:assert/strict");
const nativeFS = require("node:fs");
const path = require("node:path");
const feature = nativeFS.existsSync(path.join(__dirname, "../src/Mirakurun"));
const prefix = feature ? "../lib/Mirakurun" : "../lib/server/modules";
const _ = require(prefix + "/_").default;
const Service = require(prefix + "/Service").default;
const Event = require(prefix + "/Event").default;
const logger = require(prefix + (feature ? "/log" : "/event-log"));
for (const foundOther of [false, true]) {
    it(`[service-scan-selection] 指定SIDがない場合も、Find-Channelsから未指定サービスの全件追加へ切り替えない (other=${foundOther})`, async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        for (const level of ["debug", "info", "warn", "error"]) { t.mock.method(logger, level, () => {}); }
        const channel = { type: "GR", route: "TER", channel: "27", name: "selected", streams: [] };
        const queued = [];
        _.config = { server: { disableEITParsing: true }, channels: [{ ...channel, serviceId: 101 }] };
        _.configIntegrity = { channels: "selection" };
        _.channel = { items: [channel], get: (type, name) => type === channel.type && name === channel.channel ? channel : null };
        _.job = { jobs: [], add: job => queued.push(job), addSchedule() {} };
        _.tuner = { getServices: async () => foundOther ? [{ networkId: 1, serviceId: 102, type: 1, name: "not selected" }] : [] };
        const services = new Service(); _.service = services; _.event = new Event();
        t.after(async () => { if (services.close) { await services.close(); } else { clearTimeout(services._saveTimerId); } });
        await services._initJobs();
        for (let index = 0; index < queued.length; ++index) {
            assert.ok(index < 10, "no unbounded startup tasks");
            await queued[index].fn({ signal: new AbortController().signal });
        }
        assert.equal(queued.filter(job => job.key === "Service.Add.Check.GR.27.101").length, 1);
        assert.equal(queued.some(job => job.key === "Service.Add.Scan.GR.27"), false);
        assert.equal(services.items.length, 0);
    });
}

for (const mode of ["discovery", "ignored-route"]) {
    it(`[service-scan-selection] 有効入力の選別だけを全追加経路で守る (${mode})`, async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        for (const level of ["debug", "info", "warn", "error"]) { t.mock.method(logger, level, () => {}); }
        const channel = { type: "GR", route: mode === "discovery" ? "TER" : "CATV", channel: "27", name: "active", streams: [], getServices: () => [] };
        const queued = [];
        _.config = { server: { disableEITParsing: true }, channels: mode === "discovery" ? [{ ...channel, serviceId: 101 }]
            : [{ ...channel }, { type: "GR", route: "TER", channel: "27", serviceId: 9999, name: "ignored" }] };
        _.configIntegrity = { channels: "selection" };
        _.channel = { items: [channel], get: (type, name) => type === channel.type && name === channel.channel ? channel : null };
        _.job = { jobs: [], add: job => queued.push(job), addSchedule() {} };
        _.tuner = { getServices: async () => [{ networkId: 1, serviceId: 101, type: 1, name: "first" }, { networkId: 1, serviceId: 102, type: 1, name: "second" }] };
        const services = new Service(); _.service = services; _.event = new Event();
        t.mock.method(services, "save", () => {}); // この対照は選別経路のみを検証し、実保存はMongoの回帰テストで扱う。
        t.after(async () => { if (services.close) { await services.close(); } else { clearTimeout(services._saveTimerId); } });
        if (mode === "discovery") { services.queueDiscoveredTsmfScan(channel); } else { await services._initJobs(); }
        for (let index = 0; index < queued.length; ++index) {
            assert.ok(index < 10); await queued[index].fn({ signal: new AbortController().signal });
        }
        assert.notEqual(services.get(1, 101), null);
        assert.equal(services.get(1, 102) !== null, mode === "ignored-route");
        assert.equal(queued.some(job => job.key === "Service.Add.Check.GR.27.9999"), false);
    });
}

for (const existing of ["empty-present", "empty-missing", "stored"]) {
    for (const reverse of [false, true]) {
        it(`[service-scan-selection] SID指定行と全サービス行の混在は指定SIDの有無・登録順に関係なく補完する (${existing}, reverse=${reverse})`, async t => {
            t.mock.timers.enable({ apis: ["setTimeout"] });
            for (const level of ["debug", "info", "warn", "error"]) { t.mock.method(logger, level, () => {}); }
            const channel = { type: "GR", route: "TER", channel: "27", name: "mixed", streams: [{ format: "ts" }] };
            const rows = [{ type: "GR", channel: "27", serviceId: 101 }, { type: "GR", channel: "27" }];
            const queued = [];
            _.config = { server: { disableEITParsing: true }, channels: reverse ? rows.reverse() : rows };
            _.configIntegrity = { channels: "mixed-selection" };
            _.channel = { items: [channel], get: (type, name) => type === "GR" && name === "27" ? channel : null };
            _.job = { jobs: [], add: job => queued.push(job), addSchedule() {} };
            _.tuner = { getServices: async () => existing === "empty-missing"
                ? [{ networkId: 1, serviceId: 102, type: 1, name: "unselected" }]
                : [{ networkId: 1, serviceId: 101, type: 1, name: "selected" }, { networkId: 1, serviceId: 102, type: 1, name: "unselected" }] };
            const services = new Service(); _.service = services; _.event = new Event();
            t.mock.method(services, "save", () => {});
            t.after(async () => { if (services.close) { await services.close(); } else { clearTimeout(services._saveTimerId); } });
            if (existing === "stored") {
                const ServiceItem = require(prefix + "/ServiceItem").default;
                services.add(new ServiceItem(channel, 1, 101, "stored", 1));
            }
            await services._initJobs();
            for (let index = 0; index < queued.length; ++index) {
                assert.ok(index < 10, "no unbounded startup tasks");
                await queued[index].fn({ signal: new AbortController().signal });
            }
            const scans = queued.filter(job => job.key === "Service.Add.Scan.GR.27");
            assert.equal(scans.length, 1);
            assert.equal(scans[0].retryOnFail, existing === "empty-missing");
            assert.deepEqual(services.items.map(item => item.serviceId).sort((a, b) => a - b), existing === "empty-missing" ? [102] : [101, 102]);
        });
    }
}

for (const extra of ["disabled", "other-route"]) {
    it(`[service-scan-selection] 無効・別経路の全サービス行では指定SIDの制限を解除しない (${extra})`, async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        for (const level of ["debug", "info", "warn", "error"]) { t.mock.method(logger, level, () => {}); }
        const channel = { type: "GR", route: "TER", channel: "27", name: "selected", streams: [{ format: "ts" }] };
        const queued = [];
        _.config = { server: { disableEITParsing: true }, channels: [{ type: "GR", channel: "27", serviceId: 101 },
            { type: "GR", channel: "27", ...(extra === "disabled" ? { isDisabled: true } : { route: "CATV" }) }] };
        _.configIntegrity = { channels: "mixed-selection-control" };
        _.channel = { items: [channel], get: (type, name) => type === "GR" && name === "27" ? channel : null };
        _.job = { jobs: [], add: job => queued.push(job), addSchedule() {} };
        _.tuner = { getServices: async () => [{ networkId: 1, serviceId: 101, type: 1, name: "selected" }, { networkId: 1, serviceId: 102, type: 1, name: "unselected" }] };
        const services = new Service(); _.service = services; _.event = new Event();
        t.mock.method(services, "save", () => {});
        t.after(async () => { if (services.close) { await services.close(); } else { clearTimeout(services._saveTimerId); } });
        await services._initJobs();
        for (let index = 0; index < queued.length; ++index) {
            assert.ok(index < 10); await queued[index].fn({ signal: new AbortController().signal });
        }
        await services._scan(channel, true);
        assert.equal(queued.some(job => job.key === "Service.Add.Scan.GR.27"), false);
        assert.deepEqual(services.items.map(item => item.serviceId), [101]);
    });
}

it("[service-scan-selection] 混在入力の後着TLVも更新スキャンで全サービスを補完する", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const level of ["debug", "info", "warn", "error"]) { t.mock.method(logger, level, () => {}); }
    const channel = { type: "GR", route: "TER", channel: "27", name: "mixed TLV", streams: [{ networkId: 1, streamId: 11, format: "tlv", remote: true }] };
    _.config = { server: { disableEITParsing: true }, channels: [{ type: "GR", channel: "27", serviceId: 101 }, { type: "GR", channel: "27" }] };
    _.channel = { items: [channel], findStreamLocations: () => [{ channel, stream: channel.streams[0] }] };
    _.tuner = { getServices: async () => [{ networkId: 1, streamId: 11, serviceId: 101, type: 1, name: "selected" }, { networkId: 1, streamId: 11, serviceId: 102, type: 1, name: "unselected" }] };
    const services = new Service(); _.service = services; _.event = new Event();
    t.mock.method(services, "save", () => {});
    t.after(async () => { if (services.close) { await services.close(); } else { clearTimeout(services._saveTimerId); } });
    await services._scan(channel, false);
    assert.deepEqual(services.items.map(item => item.serviceId), [101, 102]);
});
