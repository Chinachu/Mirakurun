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
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { Writable } = require("node:stream");
const http = require("node:http");
const childProcess = require("node:child_process");
const spawnRemote = childProcess.spawn;
const express = require("express");
const { initialize } = require("express-openapi");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: {
    epg: {}, epgByStream: {}, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { bufferOverflow: 0 }
} } };
const _ = require("../lib/Mirakurun/_").default;
const Tuner = require("../lib/Mirakurun/Tuner").default;
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
const channelStream = require("../lib/Mirakurun/api/channels/{type}/{channel}/stream");
const { responseError } = require("../lib/Mirakurun/api");
const handleRequestError = (error, req, res, next) => responseError(res, error.status || 500, error.message);
const Event = require("../lib/Mirakurun/Event").default;
const event = require("../lib/Mirakurun/log");

const input = Buffer.concat([0x2F, 0x100, 0x1FFF, 0x2D, 0x2F, 0x101, 0x2D, 0x1FFF].map((pid, i) => {
    const packet = Buffer.alloc(188, 0x80 + i);
    packet[0] = 0x47;
    packet[1] = pid >> 8;
    packet[2] = pid & 0xFF;
    packet[3] = 0x10 | i;
    return packet;
}));

function fixture(t, settings = {}, holdOpen = false) {
    const previous = { config: _.config, channel: _.channel, service: _.service, tuner: _.tuner };
    _.config = { server: { disableEITParsing: true }, tuners: [] };
    for (const level of ["info", "warn", "error", "debug"]) { t.mock.method(event, level, () => undefined); }
    t.mock.method(Event, "emit", () => true);
    // 生多重配信は復号・変換コマンドを実行しない。
    const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("raw source must not start a decoder"); });
    const channel = new ChannelItem({ name: "raw carrier", type: "BS4K", channel: "C19", route: "CATV", ...settings });
    const sinks = [];
    const starts = [];
    let released = 0;
    let releaseResolve;
    const release = new Promise(resolve => { releaseResolve = resolve; });
    _.channel = { items: [channel], get: (type, name) => type === channel.type && name === channel.channel ? channel : null,
        getStreams: () => [], findStreamLocations: () => [] };
    _.service = { findByChannel: () => [], invalidateChannelIndex() {} };
    const device = {
        index: 0, isRemote: false, isAvailable: true, isFree: true, isUsing: false, channel: null, users: [],
        config: { name: "raw input", types: ["BS4K"], routes: ["CATV"], decoder: "must-not-run" },
        decoder: "must-not-run", getPriority: () => -1,
        async startStream(user, sink, selected, signal) {
            starts.push({ user, signal, channel: selected });
            sinks.push(sink);
            this.users.push(user); this.isFree = false; this.isUsing = true; this.channel = selected;
            const freed = () => {
                signal?.removeEventListener("abort", aborted);
                this.users = this.users.filter(active => active !== user);
                this.isFree = this.users.length === 0; this.isUsing = !this.isFree;
                if (this.isFree) { this.channel = null; }
                ++released; releaseResolve();
            };
            const aborted = () => sink.close();
            signal?.addEventListener("abort", aborted, { once: true });
            sink.once("close", freed);
            setImmediate(() => {
                if (sink.closed || signal?.aborted) { return; }
                sink.write(input);
                sink.flush?.();
                if (!holdOpen) { sink.close(); }
            });
        },
        async close() { for (const sink of sinks) { sink.close(); } }
    };
    const tuner = _.tuner = new Tuner();
    tuner._devices = [device];
    t.after(async () => {
        await device.close();
        _.config = previous.config; _.channel = previous.channel; _.service = previous.service; _.tuner = previous.tuner;
    });
    return { channel, tuner, device, starts, spawn, release, get released() { return released; } };
}

async function withHTTP(t, settings, run, holdOpen = false) {
    const f = fixture(t, settings, holdOpen);
    const app = express();
    app.use((req, _res, next) => {
        Object.defineProperty(req, "query", { value: { ...req.query }, writable: true, configurable: true });
        req.auth = { role: "admin", publicOnly: false }; next();
    });
    app.get("/api/auth/connection", (_req, res) => res.sendStatus(404));
    const document = { swagger: "2.0", info: { title: "raw TSMF stream fixture", version: "1.0.0" }, basePath: "/api", paths: {}, definitions: { Error: { type: "object" } } };
    initialize({ app, promiseMode: true, apiDoc: document,
        paths: [{ path: "/channels/{type}/{channel}/stream", module: channelStream }] });
    app.get("/api/docs", (_req, res) => res.json({ ...document, paths: { "/channels/{type}/{channel}/stream": {
        parameters: channelStream.parameters, get: channelStream.get.apiDoc
    } } }));
    app.use(handleRequestError);
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const endpoint = `http://127.0.0.1:${server.address().port}/api/channels/BS4K/C19/stream`;
    try { await run(endpoint, f); }
    finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

for (const settings of [{}, { format: "tlv" }]) {
    it(`[raw-tsmf-stream.spec] ${settings.format ? "明示TLV" : "未検出BS4K"}のraw HEAD/GETはTS変換器なしで外側TSを返す`, { timeout: 5000 }, async t => {
        await withHTTP(t, settings, async (endpoint, f) => {
            const head = await fetch(endpoint + "?rawTsmf=true&format=ts&decode=0", { method: "HEAD" });
            assert.equal(head.status, 200);
            assert.equal(head.headers.get("content-type"), "video/MP2T");
            assert.equal(f.starts.length, 0);
            const response = await fetch(endpoint + "?rawTsmf=true&format=ts&decode=0");
            assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
            assert.equal(response.headers.get("content-type"), "video/MP2T");
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), input);
            assert.equal(f.starts.length, 1);
            assert.equal(f.spawn.mock.callCount(), 0);
            assert.equal(f.device.users.length, 0);
        });
    });
}

it("[raw-tsmf-stream.spec] 通常のformat=tsはTLV変換器がなければHEAD/GETとも406を維持する", { timeout: 5000 }, async t => {
    await withHTTP(t, { format: "tlv" }, async (endpoint, f) => {
        for (const query of ["format=ts", "rawTsmf=false&format=ts"]) {
            for (const method of ["HEAD", "GET"]) {
                const response = await fetch(endpoint + "?" + query, { method });
                assert.equal(response.status, 406, `${method} ${query}`);
                await response.arrayBuffer();
            }
        }
        assert.equal(f.starts.length, 0);
        assert.equal(f.spawn.mock.callCount(), 0);
    });
});

it("[raw-tsmf-stream.spec] raw要求は設定の相対TSと復号を無視し、format/decode省略でも原本TSを返す", { timeout: 5000 }, async t => {
    await withHTTP(t, { format: "tlv", tsmfRelTs: 3 }, async (endpoint, f) => {
        const response = await fetch(endpoint + "?rawTsmf=true");
        assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
        assert.equal(response.headers.get("content-type"), "video/MP2T");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), input);
        assert.equal(f.starts.length, 1);
        assert.equal(f.spawn.mock.callCount(), 0);
    });
});

for (const query of ["rawTsmf=true&format=tlv", "rawTsmf=true&decode=1", "rawTsmf=true&tsmfRelTs=3", "rawTsmf=invalid", "rawTsmf=", "rawTsmf=0", "rawTsmf=1", "rawTsmf=true&rawTsmf=false"]) {
    it(`[raw-tsmf-stream.spec] 矛盾または不正なraw指定を確保前の400で拒否する (${query})`, { timeout: 5000 }, async t => {
        await withHTTP(t, {}, async (endpoint, f) => {
            const response = await fetch(endpoint + "?" + query);
            assert.equal(response.status, 400, await response.text());
            assert.equal(f.starts.length, 0);
            assert.equal(f.spawn.mock.callCount(), 0);
        });
    });
}

it("[raw-tsmf-stream.spec] raw HTTPの切断は利用者と入力を解放する", { timeout: 5000 }, async t => {
    await withHTTP(t, { format: "tlv", tsmfRelTs: 3 }, async (endpoint, f) => {
        const received = [];
        await new Promise((resolve, reject) => {
            let cancelled = false;
            const request = http.get(endpoint + "?rawTsmf=true&format=ts", response => {
                if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
                let bytes = 0;
                response.on("data", chunk => {
                    received.push(chunk); bytes += chunk.length;
                    if (bytes >= input.length) { cancelled = true; request.destroy(); resolve(); }
                });
            });
            request.on("error", error => { if (!cancelled) { reject(error); } });
        });
        let timeout;
        try { await Promise.race([f.release, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("raw user was not released")), 1000); })]); }
        finally { clearTimeout(timeout); }
        assert.deepEqual(Buffer.concat(received), input);
        assert.equal(f.device.users.length, 0);
        assert.equal(f.released, 1);
        assert.equal(f.spawn.mock.callCount(), 0);
    }, true);
});

it("[raw-tsmf-stream.spec] Tunerの明示raw引数も設定相対TSを展開せず原本TSを通す", { timeout: 5000 }, async t => {
    const f = fixture(t, { format: "tlv", tsmfRelTs: 3 });
    const received = [];
    const output = new Writable({ write(chunk, _encoding, done) { received.push(Buffer.from(chunk)); done(); } });
    t.after(() => output.destroy());
    const completed = once(output, "finish");
    await f.tuner.initChannelStream(f.channel, { id: "raw-direct", priority: 0, outputFormat: "ts" }, output, undefined, true);
    await completed;
    assert.deepEqual(Buffer.concat(received), input);
    assert.equal(f.spawn.mock.callCount(), 0);
    assert.equal(f.starts.length, 1);
});

it("[raw-tsmf-stream.spec] 実remote CLIとpeer Tuner APIを通してNULL入りの外側TSを保持する", { timeout: 10000 }, async t => {
    await withHTTP(t, { format: "tlv", tsmfRelTs: 3 }, async (endpoint, f) => {
        const url = new URL(endpoint);
        const child = spawnRemote(process.execPath, ["lib/remote", url.hostname, url.port, "BS4K", "C19", "ts", "rawTsmf=true"], {
            cwd: require("node:path").join(__dirname, ".."),
            env: { ...process.env, MIRAKURUN_REMOTE_SECRET_KEY: "sk-raw-cli-fixture", MIRAKURUN_REMOTE_PROTOCOL: "http:" }
        });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); } });
        const stdout = [], stderr = [];
        child.stdout.on("data", data => stdout.push(data));
        child.stderr.on("data", data => stderr.push(data));
        const [code] = await once(child, "close");
        const diagnostic = Buffer.concat(stderr).toString();
        assert.equal(code, 0, diagnostic);
        assert.doesNotMatch(diagnostic, /sk-raw-cli-fixture/);
        assert.deepEqual(Buffer.concat(stdout), input);
        assert.equal(f.starts.length, 1);
        assert.equal(f.spawn.mock.callCount(), 0);
        assert.equal(f.device.users.length, 0);
    });
});
