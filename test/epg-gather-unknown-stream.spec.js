/*
   Copyright 2026 kanreisa

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
const statusPath = require.resolve("../lib/Mirakurun/status");
const status = { epg: {}, epgByStream: {}, streamCount: { tsFilter: 0 }, errorCount: {} };
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: status } };
const logPath = require.resolve("../lib/Mirakurun/log");
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };
const _ = require("../lib/Mirakurun/_").default;
const Channel = require("../lib/Mirakurun/Channel").default;
function service(networkId, streamId, isTlv = true) {
    const channel = { type: isTlv ? "BS4K" : "BS", channel: "BS01_0", getDefaultRelTs: () => 3, getStreamByRelTs: () => null };
    return { networkId, serviceId: 101, streamId, isTlv, epgReady: false,
        locations: [{ channel, stream: null }] };
}
async function fixture(t, services) {
    const prior = { service: _.service, job: _.job, tuner: _.tuner };
    const server = _.config.server; _.config.server = {};
    const jobs = [];
    const readyForJob = t.mock.fn(async targets => targets[0].channel);
    const getEPG = t.mock.fn(async () => undefined);
    _.service = { items: services, get: (nid, sid) => services.find(item => item.networkId === nid && item.serviceId === sid) || null };
    _.job = { add: job => jobs.push(job) };
    _.tuner = { readyForJob, getEPG };
    status.epg = {}; status.epgByStream = {};
    t.after(() => { Object.assign(_, prior); _.config.server = server; status.epg = {}; status.epgByStream = {}; });
    const store = Object.create(Channel.prototype);
    store._startup = false;
    await store._epgGatherer(t.signal);
    return { jobs, readyForJob, getEPG };
}
it("[epg-unknown-stream] 旧TLVサービスの未確定streamIdをジョブ名やキーにundefinedとして埋め込まない", async t => {
    const item = service(11);
    const { jobs } = await fixture(t, [item]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].key, "EPG.Gather.NID.11.TSID.unknown");
    assert.equal(jobs[0].name, "EPG Gather Network#11（ストリーム未確認）");
    assert.equal(item.streamId, undefined, "未受信のstreamIdを推測してサービスへ書き戻しません");
});
it("[epg-unknown-stream] 同じネットワークの未確認TLVはまとめ、TSの取得ジョブは分ける", async t => {
    const { jobs } = await fixture(t, [service(11), { ...service(11), serviceId: 102 }, service(11, undefined, false)]);
    assert.deepEqual(jobs.map(job => job.key), ["EPG.Gather.NID.11.TSID.unknown", "EPG.Gather.NID.11"]);
});
it("[epg-unknown-stream] 既知のTLVストリームと通常TSのジョブ識別は変更しない", async t => {
    const { jobs } = await fixture(t, [service(11, 0), service(11, 22), service(11, undefined, false)]);
    assert.deepEqual(jobs.map(job => [job.key, job.name]), [
        ["EPG.Gather.NID.11.TSID.0", "EPG Gather Network#11 Stream#0"],
        ["EPG.Gather.NID.11.TSID.22", "EPG Gather Network#11 Stream#22"],
        ["EPG.Gather.NID.11", "EPG Gather Network#11"]
    ]);
});
it("[epg-unknown-stream] ネットワークの異なる未確認TLVのジョブは混ぜない", async t => {
    const { jobs } = await fixture(t, [service(11), service(12)]);
    assert.deepEqual(jobs.map(job => job.key), ["EPG.Gather.NID.11.TSID.unknown", "EPG.Gather.NID.12.TSID.unknown"]);
});
it("[epg-unknown-stream] 未確定streamIdは再スキャンまでネットワーク単位の取得中判定を使う", async t => {
    const { jobs, readyForJob } = await fixture(t, [service(11)]);
    status.epg[11] = true;
    assert.equal(await jobs[0].readyFn(t.signal), false);
    assert.equal(readyForJob.mock.callCount(), 0);
});
it("[epg-unknown-stream] 未確定streamIdでも元の入力の既定相対TSで取得を試せる", async t => {
    const item = service(11);
    const { jobs, readyForJob, getEPG } = await fixture(t, [item]);
    assert.equal(await jobs[0].readyFn(t.signal), true);
    assert.deepEqual(readyForJob.mock.calls[0].arguments[0], [{ channel: item.locations[0].channel, relTs: 3 }]);
    await jobs[0].fn({ signal: t.signal });
    assert.equal(getEPG.mock.callCount(), 1);
    assert.equal(getEPG.mock.calls[0].arguments[0], item.locations[0].channel);
    assert.equal(getEPG.mock.calls[0].arguments.at(-1), 3);
    assert.equal(item.streamId, undefined);
});

for (const [key, active, expected] of [["11/22", true, false], ["12/22", true, true], ["11/22", false, true]]) {
    it(`[epg-unknown-stream] 未確定TLVは取得中のTLVのネットワークを確認する (${key}=${active})`, async t => {
        const { jobs, readyForJob } = await fixture(t, [service(11)]);
        status.epgByStream[key] = active;
        assert.equal(await jobs[0].readyFn(t.signal), expected);
        assert.equal(readyForJob.mock.callCount(), expected ? 1 : 0);
    });
}
for (const activeId of [22, 23]) {
    it(`[epg-unknown-stream] 既定入力を特定できる未確定TLVは別ストリームを抑止しない (active=${activeId})`, async t => {
        const item = service(11);
        item.locations[0].channel.getStreamByRelTs = relTs => relTs === 3 ? { networkId: 11, streamId: 22, format: "tlv", relTs: 3 } : null;
        const { jobs, readyForJob } = await fixture(t, [item]);
        status.epgByStream[`11/${activeId}`] = true;
        assert.equal(await jobs[0].readyFn(t.signal), activeId !== 22);
        assert.equal(readyForJob.mock.callCount(), activeId === 22 ? 0 : 1);
        assert.equal(item.streamId, undefined, "入力の検出情報をサービスの確定IDとして書き戻しません");
    });
}
it("[epg-unknown-stream] 通常TSは同ネットワークのTLV取得に妨げられない", async t => {
    const { jobs, readyForJob } = await fixture(t, [service(11, undefined, false)]);
    status.epgByStream["11/22"] = true;
    assert.equal(await jobs[0].readyFn(t.signal), true);
    assert.equal(readyForJob.mock.callCount(), 1);
});
function epgPacket(packetId, payload, sequence = 0) {
    const result = Buffer.alloc(21 + payload.length);
    result.set([0x7F, 3]); result.writeUInt16BE(result.length - 4, 2);
    result.set([0, sequence & 15, 0x61, 0x40, 2], 4);
    result.writeUInt16BE(packetId, 9); result.writeUInt32BE(sequence, 15);
    payload.copy(result, 21); return result;
}
function gatheringInput(streamId) {
    const { calculateCRC32 } = require("arib-mmt-tlv-ts/crc-32.js");
    const table = Buffer.from([0x80, 0, 0, 8, 1, 2, 0, 101, 0, 0, 0x10, 0]);
    const message = Buffer.concat([Buffer.from([1]), table.subarray(0, 4), table]);
    const header = Buffer.alloc(7); header.writeUInt32BE(message.length, 3);
    const plt = epgPacket(0, Buffer.concat([header, message]));
    const section = Buffer.from([0x8B, 0xB0, 15, 0, 101, 0xC1, 0, 0, streamId >> 8, streamId & 255, 0, 11, 0, 0x8B, 0, 0, 0, 0]);
    section.writeUInt32BE(calculateCRC32(section.subarray(0, -4), -1) >>> 0, section.length - 4);
    assert.equal(calculateCRC32(section, -1), 0, "取得中の所有権はCRCが正しい実MH-EITから開始します");
    const eit = epgPacket(0x8000, Buffer.concat([Buffer.from([0x80, 0, 0, 0, section.length]), section]));
    return Buffer.concat([plt, eit, Buffer.from([0x7F, 0xFF, 0, 0])]);
}
for (const firstUnknown of [true, false]) {
    it(`[epg-unknown-stream] ${firstUnknown ? "未確定" : "確定済み"}TLVの実取得中は同streamの後続ジョブだけを省き、close後は再開できる`, async t => {
        const items = [service(11), service(11, 22), service(11, 23)];
        const { jobs, getEPG } = await fixture(t, items);
        const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
        const MHEPG = require("../lib/Mirakurun/MHEPG").default;
        t.mock.method(MHEPG.prototype, "write", () => undefined);
        const first = jobs[firstUnknown ? 0 : 1], next = jobs[firstUnknown ? 1 : 0];
        const started = Promise.withResolvers(), release = Promise.withResolvers();
        let filter;
        getEPG.mock.mockImplementation(async () => {
            filter = new TLVFilter({ parseEIT: true });
            filter.write(gatheringInput(22));
            started.resolve();
            try { await release.promise; } finally { filter.close(false); }
        });
        let running;
        t.after(async () => { release.resolve(); await running; filter?.close(false); });
        assert.equal(await first.readyFn(t.signal), true);
        running = first.fn({ signal: t.signal });
        await started.promise;
        assert.equal(status.epg[11], undefined, "TLVはTS用のネットワーク所有権を書き換えません");
        assert.equal(status.epgByStream["11/22"], true);
        assert.equal(await next.readyFn(t.signal), false);
        assert.equal(await jobs[2].readyFn(t.signal), true, "別TLVストリームの通常取得は維持します");
        release.resolve(); await running;
        assert.equal(status.epgByStream["11/22"], false);
        assert.equal(await next.readyFn(t.signal), true);
        assert.equal(getEPG.mock.callCount(), 1);
    });
}
for (const itemUnknown of [true, false]) {
    it(`[epg-unknown-stream] チューナー照会のawait中に同streamの取得が始まった場合も確保を進めない (unknown=${itemUnknown})`, async t => {
        const { jobs, readyForJob } = await fixture(t, [service(11, itemUnknown ? undefined : 22)]);
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        readyForJob.mock.mockImplementation(async targets => { entered.resolve(); await release.promise; return targets[0].channel; });
        t.after(() => release.resolve());
        const pending = jobs[0].readyFn(t.signal);
        await entered.promise;
        status.epgByStream["11/22"] = true;
        release.resolve();
        assert.equal(await pending, false);
        assert.equal(readyForJob.mock.callCount(), 1);
    });
}

it("[epg-unknown-stream] 既定入力の検出情報もID未確定ならネットワークの取得中状態へ戻す", async t => {
    const item = service(11);
    item.locations[0].channel.getStreamByRelTs = () => ({ networkId: 11, format: "tlv", relTs: 3 });
    const { jobs, readyForJob } = await fixture(t, [item]);
    status.epgByStream["11/22"] = true;
    assert.equal(await jobs[0].readyFn(t.signal), false);
    assert.equal(readyForJob.mock.callCount(), 0);
    assert.equal(item.streamId, undefined);
});

for (const testCase of [
    { label: "別TLVに未来番組だけがあっても対象の取得を再開する", future: [202], ready: true, epgReady: false },
    { label: "対象サービスに未来番組があれば放送休止として待つ", future: [101], ready: false, epgReady: true },
    { label: "別TLVの放送中番組で対象サービスの休止を解除しない", current: [202], future: [101], ready: false, epgReady: true },
    { label: "対象サービスが放送中なら取得を進める", current: [101], future: [202], ready: true, epgReady: true },
    { label: "同じ未確定グループの別サービスも休止判定に含める", members: [101, 102], future: [102], ready: false, epgReady: true },
    { label: "TSの未来番組は既存どおりネットワーク全体で判定する", tlv: false, future: [202], ready: false, epgReady: true },
    { label: "TSの放送中番組は既存どおりネットワーク全体で判定する", tlv: false, current: [202], future: [101], ready: true, epgReady: true }
]) {
    it(`[epg-unknown-stream] streamId未確定でも${testCase.label}`, async t => {
        const now = Date.now();
        const previousProgram = _.program;
        t.after(() => { _.program = previousProgram; });
        const current = (testCase.current ?? []).map(serviceId => ({ networkId: 11, serviceId, name: "on-air" }));
        const future = (testCase.future ?? []).map(serviceId => ({ networkId: 11, serviceId, name: "future" }));
        _.program = { findByNetworkIdAndTime: () => current, findByNetworkId: () => [...current, ...future] };
        const item = service(11, undefined, testCase.tlv !== false);
        item.epgReady = true; item.epgUpdatedAt = now - 3600_000;
        const items = [item, ...(testCase.members ?? []).filter(id => id !== item.serviceId).map(serviceId => ({ ...item, serviceId }))];
        const { jobs, readyForJob } = await fixture(t, items);
        assert.equal(jobs.length, 1);
        assert.equal(await jobs[0].readyFn(t.signal), testCase.ready);
        assert.equal(readyForJob.mock.callCount(), testCase.ready ? 1 : 0);
        assert.equal(item.epgReady, testCase.epgReady);
        assert.equal(item.streamId, undefined, "休止判定で未受信のstreamIdを推測しません");
    });
}
