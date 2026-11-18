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
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

// The branch has no UI test runner. Compile the current source without writing lib/.
function loadSource(file, mocks = {}, extraExports = [], globals = {}) {
    const filename = path.join(__dirname, "..", file);
    const source = fs.readFileSync(filename, "utf8") + (extraExports.length ? `\nexport { ${extraExports.join(", ")} };` : "");
    const result = ts.transpileModule(source, {
        fileName: filename,
        reportDiagnostics: true,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true }
    });
    assert.deepEqual(result.diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), []);
    const localRequire = createRequire(filename);
    const requireMock = name => Object.hasOwn(mocks, name) ? mocks[name] : name.endsWith(".sass") ? {} : localRequire(name);
    const module = { exports: {} };
    new Function("require", "module", "exports", ...Object.keys(globals), result.outputText)(requireMock, module, module.exports, ...Object.values(globals));
    return module.exports;
}

const channelRoutes = loadSource("src/channel-routes.ts");
const constants = loadSource("src/ui/modules/constants.ts", { "../../channel-routes": channelRoutes });
const regexp = loadSource("src/ui/modules/regexp.ts");
const silentConsole = { log() {}, debug() {}, error() {} };

function mountServiceState(initialServices) {
    let services = initialServices;
    const requests = [], timers = [];
    class StateRPCClient extends EventEmitter {
        constructor() { super(); this.methods = new Map(); StateRPCClient.instance = this; }
        async call(method) {
            requests.push(method);
            if (method === "getStatus") { return { version: "same-version", time: Date.now() }; }
            if (method === "getServices") { return services.map(service => ({ ...service })); }
            return [];
        }
        isConnected() { return true; }
    }
    const { state } = loadSource("src/ui/modules/state.ts", {
        "jsonrpc2-ws": { Client: StateRPCClient }, "./at": { setSchedule() {} }, "./ui": { setFavicon() {} },
        "../icon.svg": "normal", "../icon-gray.svg": "offline", "../icon-active.svg": "active"
    }, [], {
        location: { pathname: "/dev/service-index-test", protocol: "http:", host: "127.0.0.1:40772", reload() { throw new Error("unexpected reload"); } },
        document: { hidden: false }, console: silentConsole,
        setInterval(callback, milliseconds) { const timer = { callback, milliseconds, active: true }; timers.push(timer); return timer; },
        clearInterval(timer) { timer.active = false; }
    });
    const rpc = StateRPCClient.instance;
    const notifications = [];
    state.on("services", rows => notifications.push(rows.map(service => service.id)));
    return { state, rpc, requests, timers, notifications, setServices(rows) { services = rows; },
        async connected() {
            // 実Stateが登録した接続完了callbackを、RPCの通知境界で完了まで待つ。
            await Promise.all(rpc.listeners("connected").map(callback => callback()));
        },
        close() { state.removeAllListeners(); rpc.removeAllListeners(); for (const timer of timers) { timer.active = false; } }
    };
}

function elements(node, predicate) {
    if (Array.isArray(node)) { return node.flatMap(child => elements(child, predicate)); }
    if (!React.isValidElement(node)) { return []; }
    return [...(predicate(node) ? [node] : []), ...Object.values(node.props).flatMap(value => elements(value, predicate))];
}

// Run component callbacks with persistent hook state; network calls and effects stay local.
async function mountChannels(channels = [{ name: "Cable", type: "BS", channel: "C13", route: "CATV" }], respond) {
    const slots = [];
    const effects = [];
    const cleanups = new Map();
    const requests = [];
    let cursor = 0;
    let tree;
    const hooks = {
        ...React,
        useState(initial) {
            const index = cursor++;
            if (!(index in slots)) { slots[index] = typeof initial === "function" ? initial() : initial; }
            return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
        },
        useRef(initial) {
            const index = cursor++;
            return slots[index] || (slots[index] = { current: initial });
        },
        useEffect(callback, deps) {
            const index = cursor++;
            if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index][i]))) {
                slots[index] = deps;
                effects.push(() => {
                    cleanups.get(index)?.();
                    const cleanup = callback();
                    if (typeof cleanup === "function") { cleanups.set(index, cleanup); } else { cleanups.delete(index); }
                });
            }
        }
    };
    const fetchMock = async (url, options = {}) => {
        requests.push({ url, ...options });
        if (respond) { const response = await respond(url, options); if (response) { return response; } }
        const body = url === "/api/config/channels" ? channels : url === "/api/config/tuners" ? [] : { status: "idle", isScanning: false };
        return { ok: true, status: options.method === "PUT" ? 202 : 200, json: async () => body };
    };
    const { ChannelsConfigView } = loadSource("src/ui/routes/ChannelsConfigView.tsx", {
        react: hooks,
        "../modules/constants": constants,
        "../modules/state": { state: {} },
        "../modules/ui": { setTitle() {} }
    }, [], { fetch: fetchMock, console: silentConsole, setInterval: () => 1, clearInterval() {} });
    const render = () => { cursor = 0; tree = ChannelsConfigView(); return tree; };
    const find = predicate => {
        const result = elements(tree, predicate);
        assert.equal(result.length, 1, "expected one matching control");
        return result[0];
    };
    const input = label => {
        let groups = elements(tree, node => node.props.label === label);
        if (groups.length > 1) { groups = elements(find(node => node.props.title === "Channel Scan"), node => node.props.label === label); }
        assert.equal(groups.length, 1, `expected one field: ${label}`);
        return elements(groups[0].props.children, node => typeof node.props.onChange === "function" || typeof node.props.onInput === "function")[0];
    };
    const change = (label, value, badInput = false) => {
        const props = input(label).props;
        const target = { value, validity: { badInput } };
        (props.onInput || props.onChange)({ target, currentTarget: target }); render();
    };
    render();
    for (let i = 0; i < 3; i++) {
        for (const effect of effects.splice(0)) { effect(); }
        await new Promise(resolve => setImmediate(resolve));
        render();
    }
    requests.length = 0;
    return { render, find, input, change, requests, unmount: () => { for (const cleanup of cleanups.values()) { cleanup(); } cleanups.clear(); }, flushEffects: () => { for (const effect of effects.splice(0)) { effect(); } }, start: () => find(node => node.props.children === "Start Scan").props.onClick() };
}

describe("TSMF/TLV UI backports", () => {

    for (const remote of [false, true]) {
        it(`explains TLV decoder applicability for ${remote ? "remote" : "local"} tuners without hiding its setting`, async () => {
            const slots = [], effects = [];
            let cursor = 0;
            const tuner = { name: "tlv", types: ["BS4K"], tlvDecoder: "tlv-decode", tlvToTsDecoder: "tlv-to-ts",
                ...(remote ? { remoteMirakurunHost: "peer", remoteMirakurunDecoder: true } : { command: "tuner-command" }) };
            const hooks = { ...React,
                useState(initial) {
                    const index = cursor++;
                    if (!(index in slots)) { slots[index] = typeof initial === "function" ? initial() : initial; }
                    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
                },
                useEffect(callback, deps) {
                    const index = cursor++;
                    if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index][i]))) { slots[index] = deps; effects.push(callback); }
                }
            };
            let requests = 0;
            const { TunersConfigView } = loadSource("src/ui/routes/TunersConfigView.tsx", {
                react: hooks, "../modules/state": { state: {} }, "../modules/ui": { setTitle() {} },
                "../../Mirakurun/command": loadSource("src/Mirakurun/command.ts"), "../modules/constants": constants
            }, [], { console: silentConsole, fetch: async () => { requests++; return { json: async () => [tuner] }; } });
            let tree;
            for (let i = 0; i < 3; i++) {
                cursor = 0; tree = TunersConfigView();
                for (const effect of effects.splice(0)) { effect(); }
                await new Promise(resolve => setImmediate(resolve));
            }
            const fields = elements(tree, node => node.props.label === "TLV Decoder");
            assert.equal(fields.length, 1);
            const field = fields[0];
            assert.equal(elements(field.props.children, node => node.props.value === "tlv-decode").length, 1);
            assert.match(field.props.helperText, /空欄の場合、このMirakurunではTLVを復号しません/);
            assert.match(field.props.helperText, /Mirakurun を実行する環境で利用できる/);
            if (remote) {
                assert.match(field.props.helperText, /通常のリモート受信には適用されません/);
                assert.match(field.props.helperText, /生TSMFを取得してこのMirakurunで展開する場合に使用します/);
                assert.match(field.props.helperText, /Decode \(Remote Mirakurun Decoder\)/);
            } else { assert.doesNotMatch(field.props.helperText, /通常のリモート受信には適用されません/); }
            assert.equal(requests, 1);
        });
    }
    for (const [label, key] of [["TsmfRelTs", "tsmfRelTs"], ["TsmfGroupId", "tsmfGroupId"]]) {
        for (const corrected of ["8", ""]) {
            it(`keeps invalid native numeric input pending until corrected (${label}: ${JSON.stringify(corrected)})`, async () => {
                const view = await mountChannels([{ name: "Cable", type: "BS", channel: "C13", tsmfRelTs: 7, tsmfGroupId: 7 }]);
                view.change(label, "", true);
                assert.equal(view.find(node => node.props.label === label).props.intent, "danger");
                await view.find(node => node.props.children === "保存").props.onClick();
                assert.equal(view.requests.filter(request => request.method === "PUT").length, 0);
                view.change(label, corrected);
                assert.equal(view.find(node => node.props.label === label).props.intent, undefined);
                await view.find(node => node.props.children === "保存").props.onClick();
                const puts = view.requests.filter(request => request.method === "PUT");
                assert.equal(puts.length, 1);
                const saved = JSON.parse(puts[0].body)[0];
                if (corrected === "") { assert.equal(key in saved, false); }
                else { assert.equal(saved[key], 8); }
            });
        }
    }
    for (const route of ["SAT", "FTTH"]) {
        it(`accepts the displayed preset as a channel list without changing its channels (${route})`, async () => {
            const view = await mountChannels();
            view.change("Route", route);
            const dialog = view.find(node => node.props.title === "Channel Scan");
            const text = elements(dialog, node => node.type?.displayName === "Blueprint5.Callout" || node.type?.name === "Callout")
                .map(node => node.props.children).flat().filter(value => typeof value === "string" && value.includes("BS01_0")).join("");
            assert.ok(text, "preset channel list must be displayed");
            view.change("Channels", "list");
            view.change("Channel List (comma separated)", text);
            await view.start();
            const puts = view.requests.filter(request => request.method === "PUT");
            assert.equal(puts.length, 1);
            const channels = new URL(puts[0].url, "http://localhost").searchParams.get("channels").split(",");
            const satellite = [
                ...Array.from({ length: 23 }, (_, i) => Array.from({ length: 4 }, (_, sub) => `BS${String(i + 1).padStart(2, "0")}_${sub}`)).flat(),
                ...Array.from({ length: 23 }, (_, i) => `CS${i + 2}`)
            ];
            assert.deepEqual(channels, route === "SAT" ? satellite : [...Array.from({ length: 50 }, (_, i) => String(i + 13)), ...satellite]);
            assert.equal(channels.length, route === "SAT" ? 115 : 165);
        });
    }

    it("omits an absent channel type from weekly EPG date links", () => {
        for (const channel of [undefined, { type: "GR", channel: "13" }]) {
            const slots = [], pendingEffects = [], cleanups = [], navigations = [];
            let cursor = 0;
            const date = require("luxon").DateTime.fromISO("2026-11-13", { zone: "Asia/Tokyo" });
            const service = { id: 400101, networkId: 4, serviceId: 101, name: "Weekly", type: 1, channel };
            const state = new EventEmitter();
            Object.assign(state, { services: [service], todayTime: date.toMillis(), location: "/epg",
                programs: [{ id: 1, eventId: 1, networkId: 4, serviceId: 101, name: "Program", startAt: date.toMillis(), duration: 3600000 }],
                subscribePrograms() {}, navigate: url => navigations.push(url) });
            const hooks = { ...React,
                useState(initial) {
                    const index = cursor++;
                    if (!(index in slots)) { slots[index] = typeof initial === "function" ? initial() : initial; }
                    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
                },
                useRef() {
                    const index = cursor++;
                    return slots[index] || (slots[index] = { current: { offsetHeight: 60, offsetWidth: 180, scrollHeight: 1680,
                        scrollTop: 0, scrollLeft: 0, clientHeight: 600, style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, removeEventListener() {} } });
                },
                useEffect(callback, deps) {
                    const index = cursor++;
                    if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index][i]))) {
                        slots[index] = deps; pendingEffects.push(callback);
                    }
                }
            };
            const { EPGTable } = loadSource("src/ui/components/EPGTable.tsx", {
                react: hooks, "../modules/state": { state }, "../modules/ui": { setTitle() {}, blur() {} },
                "../modules/common": { LazyCaller: class { constructor(_a, _b, callback) { this.caller = callback; } destroy() {} } },
                "../modules/constants": constants, "../modules/regexp": regexp,
                "./ProgramTitle": { ProgramTitle: () => null }, "./ProgramPopover": { ProgramPopover: () => null }, "./ProgramGenres": { ProgramGenres: () => null }
            }, [], { console: silentConsole, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} });
            let tree;
            for (let i = 0; i < 5; i++) {
                cursor = 0; tree = EPGTable({ date, globalServiceId: service.id });
                for (const effect of pendingEffects.splice(0)) { const cleanup = effect(); if (typeof cleanup === "function") { cleanups.push(cleanup); } }
            }
            const headers = elements(tree, node => node.props.className === "epg-table-header-item date");
            assert.equal(headers.length, 8);
            headers[0].props.onClick();
            assert.deepEqual(navigations, [channel ? "/epg?type=GR&date=2026-11-13" : "/epg?date=2026-11-13"]);
            for (const cleanup of cleanups.reverse()) { cleanup(); }
        }
    });

    it("keeps the remaining group ID validation after correcting the relative TS", async () => {
        const view = await mountChannels();
        view.change("TsmfRelTs", "16"); view.change("TsmfGroupId", "256");
        assert.equal(view.find(node => node.props.label === "TsmfRelTs").props.intent, "danger");
        assert.equal(view.find(node => node.props.label === "TsmfGroupId").props.intent, "danger");
        view.change("TsmfRelTs", "1");
        assert.equal(view.find(node => node.props.label === "TsmfRelTs").props.intent, undefined);
        assert.match(view.find(node => node.props.label === "TsmfGroupId").props.helperText, /1行目.*1以上255以下/);
        await view.find(node => node.props.children === "保存").props.onClick();
        assert.equal(view.requests.length, 0);
    });

    it("omits an unknown MMT resolution while keeping known video metadata", () => {
        const { ProgramAVInfo } = loadSource("src/ui/components/ProgramAVInfo.tsx", { "../modules/constants": constants });
        /** @type {import("../api").ProgramMMTVideo} */
        const mmtVideo = { resolution: null, frameRate: "60", transferCharacteristics: "bt2100-hlg" };
        assert.equal(typeof mmtVideo.frameRate, "string");
        const markup = renderToStaticMarkup(React.createElement(ProgramAVInfo, { mmtVideo }));
        assert.doesNotMatch(markup, /class="video resolution"/);
        assert.match(markup, /60fps/);
        const known = renderToStaticMarkup(React.createElement(ProgramAVInfo, { mmtVideo: { resolution: "2160p" } }));
        assert.match(known, /class="video resolution">2160p/);
    });

    it("labels a single nondefault route and leaves the default route concise", () => {
        const { ServiceTooltip } = loadSource("src/ui/routes/HomeView.tsx", {
            "../modules/constants": constants,
            "../modules/state": { state: {} },
            "../modules/ui": {}
        }, ["ServiceTooltip"]);
        const service = { id: 1, networkId: 4, serviceId: 101, type: 1, channel: { type: "BS", channel: "C13", route: "CATV" } };
        assert.match(renderToStaticMarkup(React.createElement(ServiceTooltip, { service })), /Channel \(CATV\): BS \/ C13/);
        service.channel = { type: "BS", channel: "BS01_0" };
        assert.match(renderToStaticMarkup(React.createElement(ServiceTooltip, { service })), /Channel: BS \/ BS01_0/);
    });

    it("subscribes to service metadata for the free-program badge and releases the listener", () => {
        const state = new EventEmitter();
        let service;
        state.getService = () => service;
        let subscription;
        const hooks = { ...React, useMemo: compute => compute(), useSyncExternalStore: (subscribe, snapshot) => {
            subscription = { subscribe, snapshot };
            return snapshot();
        } };
        const { ProgramTitle } = loadSource("src/ui/components/ProgramTitle.tsx", {
            react: hooks,
            "../modules/constants": constants,
            "../modules/regexp": regexp,
            "../modules/state": { state }
        });
        const program = { networkId: 32752, serviceId: 701, name: "Test", isFree: true };
        assert.doesNotMatch(renderToStaticMarkup(ProgramTitle({ program })), /attribute-無|bg-attribute-free/);
        assert.ok(subscription, "the title must observe service changes");
        let changes = 0;
        const unsubscribe = subscription.subscribe(() => { changes++; });
        service = { isFree: false };
        state.emit("services", [service]);
        assert.equal(changes, 1);
        assert.equal(subscription.snapshot(), false);
        assert.match(renderToStaticMarkup(ProgramTitle({ program })), />無<\/span>/);
        service = { isFree: true };
        state.emit("services", [service]);
        assert.equal(subscription.snapshot(), true);
        assert.doesNotMatch(renderToStaticMarkup(ProgramTitle({ program })), />無<\/span>/);
        unsubscribe();
        assert.equal(state.listenerCount("services"), 0);
    });

    it("shares one service listener across many title subscriptions and releases it once", () => {
        const state = new (require("eventemitter3").EventEmitter)();
        let service;
        let subscription;
        let offCalls = 0;
        state.getService = () => service;
        const originalOff = state.off;
        state.off = function(...args) { offCalls++; return originalOff.apply(this, args); };
        const hooks = { ...React, useMemo: compute => compute(), useSyncExternalStore: (subscribe, snapshot) => { subscription = { subscribe, snapshot }; return snapshot(); } };
        const { ProgramTitle } = loadSource("src/ui/components/ProgramTitle.tsx", {
            react: hooks, "../modules/constants": constants, "../modules/regexp": regexp, "../modules/state": { state }
        });
        const program = { networkId: 32752, serviceId: 701, name: "Test", isFree: true };
        ProgramTitle({ program });
        let changes = 0;
        const subscriptions = Array.from({ length: 2000 }, () => subscription.subscribe(() => { changes++; }));
        assert.equal(state.listenerCount("services"), 1);
        service = { isFree: false }; state.emit("services", [service]);
        assert.equal(changes, 2000);
        assert.equal(subscription.snapshot(), false);
        for (const unsubscribe of subscriptions.splice(0, 1000)) { unsubscribe(); }
        assert.equal(offCalls, 0);
        service = undefined; state.emit("services", []);
        assert.equal(subscription.snapshot(), undefined);
        assert.equal(changes, 3000);
        for (const unsubscribe of subscriptions) { unsubscribe(); }
        assert.equal(state.listenerCount("services"), 0);
        assert.equal(offCalls, 1);
        const unsubscribe = subscription.subscribe(() => {});
        service = { isFree: true }; state.emit("services", [service]);
        assert.equal(subscription.snapshot(), true);
        unsubscribe();
        assert.equal(state.listenerCount("services"), 0);
        assert.equal(offCalls, 2);
    });

    const { expandChannelRanges } = loadSource("src/ui/routes/ChannelsConfigView.tsx", {
        "../modules/constants": constants,
        "../modules/state": { state: {} },
        "../modules/ui": {}
    }, ["expandChannelRanges"]);

    it("keeps offset and large decimal channel identifiers opaque", () => {
        const long = "9".repeat(100);
        assert.deepEqual(expandChannelRanges(`4-,13x,11727000,${long},C13-15,BS01_0-BS01_2`), [
            "4-", "13x", "11727000", long, "C13", "C14", "C15", "BS01_0", "BS01_1", "BS01_2"
        ]);
    });

    it("rejects numeric-looking literals and range expansions", () => {
        for (const value of ["1e3", "1.5", "+2", "-1", "0x10", "Infinity", "1e1-2", "1.1-2", "0x1-2"]) {
            assert.throws(() => expandChannelRanges(value), undefined, value);
        }
    });

    it("rejects explicit range prefixes that differ without losing opaque identifiers", () => {
        for (const value of ["BS01_0-BS23_3", "C13-D20", "13-C20", "13-BS01_3", "BS01_0,BS01_1-BS23_3"]) {
            assert.throws(() => expandChannelRanges(value), /範囲の開始と終了には同じ接頭辞を指定してください/, value);
        }
        assert.deepEqual(expandChannelRanges("C13-15,BS01_0-BS01_3,4-,C22-,C24+,1-2-3,73750"), [
            "C13", "C14", "C15", "BS01_0", "BS01_1", "BS01_2", "BS01_3", "4-", "C22-", "C24+", "1-2-3", "73750"
        ]);
    });

    it("does not PUT a mismatched prefix range from either list or skip input", async () => {
        for (const target of ["channels", "skipCh"]) {
            for (const value of ["BS01_0-BS23_3", "C13-D20", "13-C20", "13-BS01_3", "BS01_0,BS01_1-BS23_3"]) {
                const view = await mountChannels();
                if (target === "channels") { view.change("Channels", "list"); }
                view.change(target === "channels" ? "Channel List (comma separated)" : "Skip Channels (comma separated)", value);
                await view.start(); view.render();
                assert.equal(view.requests.filter(request => request.method === "PUT").length, 0);
                assert.match(view.find(node => node.props.title === "Failed to start the scan").props.children, /範囲の開始と終了には同じ接頭辞を指定してください/);
            }
        }
    });

    it("still submits supported list and skip ranges and opaque channel names", async () => {
        const view = await mountChannels();
        const value = "C13-15,BS01_0-BS01_3,4-,C22-,C24+,1-2-3,73750";
        view.change("Channels", "list");
        view.change("Channel List (comma separated)", value);
        view.change("Skip Channels (comma separated)", value);
        await view.start();
        const puts = view.requests.filter(request => request.method === "PUT");
        assert.equal(puts.length, 1);
        const params = new URL(puts[0].url, "http://localhost").searchParams;
        const expected = "C13,C14,C15,BS01_0,BS01_1,BS01_2,BS01_3,4-,C22-,C24+,1-2-3,73750";
        assert.equal(params.get("channels"), expected);
        assert.equal(params.get("skipCh"), expected);
    });

    it("keeps scan auto-disable as omitted and sends an explicit No or Yes", async () => {
        for (const value of ["", "false", "true"]) {
            const view = await mountChannels();
            assert.equal(view.input("Set Disabled on Add").props.value, "");
            view.change("Route", "SAT");
            if (value !== "") { view.change("Set Disabled on Add", value); }
            await view.start();
            const puts = view.requests.filter(request => request.method === "PUT");
            assert.equal(puts.length, 1);
            assert.equal(new URL(puts[0].url, "http://localhost").searchParams.get("setDisabledOnAdd"), value === "" ? null : value);
        }
    });

    it("clears field validation helpers immediately after correcting relative TS and group IDs", async () => {
        const view = await mountChannels();
        for (const [label, invalid, valid] of [["TsmfRelTs", "16", "1"], ["TsmfGroupId", "256", "255"]]) {
            view.change(label, invalid);
            assert.ok(view.find(node => node.props.label === label).props.helperText);
            view.change(label, valid);
            assert.equal(view.find(node => node.props.label === label).props.helperText, undefined);
        }
        assert.equal(view.requests.filter(request => request.method === "PUT").length, 0);
    });

    it("bounds ranges, raw expanded counts and individual channel names", () => {
        for (const value of ["C65535-C65536", "C3-C2", "0-4096", "C0-C2048,C0-C2048", "C".repeat(1025), "C13,,C14"]) {
            assert.throws(() => expandChannelRanges(value), undefined, value.slice(0, 40));
        }
        assert.deepEqual(expandChannelRanges("65535-65535"), ["65535"]);
        assert.deepEqual(expandChannelRanges(""), []);
    });

    it("validates an empty SKY preset and empty list or format before fetching", async () => {
        for (const [route, source] of [["SKY", "preset"], ["TER", "list"], ["TER", "format"]]) {
            const view = await mountChannels();
            view.change("Route", route);
            view.change("Channels", source);
            if (source === "format") { view.change("Channel Name Format", "  "); }
            await view.start();
            view.render();
            assert.equal(view.requests.length, 0, `${route}/${source} must be rejected locally`);
            assert.ok(view.find(node => node.props.title === "Failed to start the scan").props.children);
        }
    });

    it("limits the encoded scan URL and still accepts opaque numeric identifiers", async () => {
        const view = await mountChannels();
        view.change("Channels", "list");
        view.change("Channel List (comma separated)", Array.from({ length: 10 }, (_, i) => "あ".repeat(100) + i).join(","));
        await view.start();
        assert.equal(view.requests.length, 0);
        view.change("Channel List (comma separated)", "4-,11727000");
        await view.start();
        const request = view.requests.find(item => item.method === "PUT");
        assert.ok(request);
        assert.equal(new URL(request.url, "http://localhost").searchParams.get("channels"), "4-,11727000");
        const overhead = request.url.length - encodeURIComponent("4-,11727000").length;
        const channels = Array.from({ length: 7 }, (_, i) => String(i) + "x".repeat(1023));
        channels.push("z".repeat(8192 - overhead - 7 * 3 - 7 * 1024));
        view.requests.length = 0;
        view.change("Channel List (comma separated)", channels.join(","));
        await view.start();
        assert.equal(view.requests.find(item => item.method === "PUT").url.length, 8192);
        view.requests.length = 0;
        channels[7] += "z";
        view.change("Channel List (comma separated)", channels.join(","));
        await view.start();
        assert.equal(view.requests.length, 0);
    });

    it("keeps invalid group IDs visible and blocks their save", async () => {
        for (const value of [0, 256, -1, 1.5]) {
            const view = await mountChannels([{ name: "Cable", type: "BS", channel: "C13", route: "CATV", tsmfGroupId: value }]);
            const field = view.input("TsmfGroupId");
            assert.equal(field.props.type, "number");
            assert.equal(field.props.min, 1);
            assert.equal(field.props.max, 255);
            assert.equal(field.props.value, String(value));
            assert.equal(view.find(node => node.props.label === "TsmfGroupId").props.intent, "danger");
            const save = view.find(node => node.props.text === "Save");
            assert.equal(save.props.disabled, true);
            view.change("TsmfGroupId", "255");
            assert.equal(view.find(node => node.props.label === "TsmfGroupId").props.intent, undefined);
            view.change("TsmfGroupId", "256");
            assert.equal(view.input("TsmfGroupId").props.value, "256");
            assert.equal(view.find(node => node.props.text === "Save").props.disabled, true);
            view.change("TsmfGroupId", "1");
            await view.find(node => node.props.children === "保存").props.onClick();
            assert.equal(JSON.parse(view.requests.find(item => item.method === "PUT").body)[0].tsmfGroupId, 1);
            view.requests.length = 0;
            view.change("TsmfGroupId", "");
            await view.find(node => node.props.children === "保存").props.onClick();
            assert.equal("tsmfGroupId" in JSON.parse(view.requests.find(item => item.method === "PUT").body)[0], false);
        }
    });

    it("keeps late tuner-config failures separate from an accepted scan", async () => {
        let rejectTuners;
        const view = await mountChannels(undefined, async url => {
            if (url === "/api/config/tuners") { return new Promise((_resolve, reject) => { rejectTuners = reject; }); }
        });
        const opening = view.find(node => node.props.text === "Channel Scan").props.onClick();
        view.render();
        await view.start();
        view.render();
        assert.equal(view.find(node => node.props.title === "Channel Scan").props.isOpen, false);
        rejectTuners(new Error("late-tuners-failure"));
        await opening;
        view.render();
        assert.equal(elements(view.find(node => node.props.title === "Channel Scan"), node => node.props.title === "チューナー設定を取得できませんでした").length, 0);
    });

    it("shows tuner-config failures only in the scan dialog", async () => {
        const view = await mountChannels(undefined, async url => {
            if (url === "/api/config/tuners") { throw new Error("tuners-unavailable"); }
        });
        await view.find(node => node.props.text === "Channel Scan").props.onClick();
        view.render();
        assert.equal(view.find(node => node.props.title === "チューナー設定を取得できませんでした").props.children, "tuners-unavailable");
        assert.equal(elements(view.find(node => node.props.title === "Channel Scan"), node => node.props.title === "Failed to start the scan").length, 0);
    });

    for (const value of [0, null, ""]) {
        it(`normalizes a legacy relative TS in scan results before applying and saving it (${JSON.stringify(value)})`, async () => {
            const rawResult = [{ name: "legacy scan", type: "BS", channel: "C21", tsmfRelTs: value }];
            const view = await mountChannels([], async url => {
                if (url.includes("/scan")) { return { ok: true, status: 200, json: async () => ({ status: "completed", isScanning: false, result: rawResult }) }; }
            });
            await view.find(node => node.props.children === "スキャン結果を適用" && node.props.small).props.onClick();
            view.render();
            assert.equal(view.input("TsmfRelTs").props.value, "");
            await view.find(node => node.props.children === "保存").props.onClick();
            assert.equal(view.requests.filter(item => item.method === "PUT").length, 1);
            assert.equal("tsmfRelTs" in JSON.parse(view.requests.find(item => item.method === "PUT").body)[0], false);
            assert.equal(rawResult[0].tsmfRelTs, value);
        });
    }


    for (const value of [0, null, ""]) {
        it(`normalizes a legacy relative TS to unspecified when saving unrelated edits (${JSON.stringify(value)})`, async () => {
            const view = await mountChannels([{ name: "legacy", type: "BS", channel: "C21", tsmfRelTs: value }]);
            assert.equal(view.input("TsmfRelTs").props.value, "");
            view.change("TsmfGroupId", "1");
            await view.find(node => node.props.children === "保存").props.onClick();
            assert.equal(view.requests.filter(item => item.method === "PUT").length, 1);
            const row = JSON.parse(view.requests.find(item => item.method === "PUT").body)[0];
            assert.equal("tsmfRelTs" in row, false);
            assert.equal(row.tsmfGroupId, 1);
        });
    }


    it("keeps the pending scan source stable and applies buffered tuner config after a 400", async () => {
        let resolveTuners;
        let resolveScan;
        const view = await mountChannels(undefined, async (url, init) => {
            if (url === "/api/config/tuners") { return new Promise(resolve => { resolveTuners = resolve; }); }
            if (init.method === "PUT") { return new Promise(resolve => { resolveScan = resolve; }); }
        });
        const opening = view.find(node => node.props.text === "Channel Scan").props.onClick();
        view.change("Route", "SAT");
        const starting = view.start();
        resolveTuners({ ok: true, json: async () => [{ name: "sat", types: ["BS"], routes: ["SAT"], command: "dvbv5-zap -a 0" }] });
        await opening;
        view.render();
        // Apply effects like React would before observing the source.
        view.flushEffects();
        view.render();
        const sourceWhileStarting = view.input("Channels").props.value;
        resolveScan({ status: 400, json: async () => ({ reason: "指定内容を確認してください。" }) });
        await starting;
        view.render(); view.flushEffects(); view.render();
        assert.equal(sourceWhileStarting, "preset");
        assert.equal(view.input("Channels").props.value, "dvbConf");
    });


    for (const failure of ["validation", "400", "409"]) {
        it(`applies delayed tuner config after a rejected scan (${failure})`, async () => {
            let resolveTuners;
            const view = await mountChannels(undefined, async (url, init) => {
                if (url === "/api/config/tuners") { return new Promise(resolve => { resolveTuners = resolve; }); }
                if (init.method === "PUT") { return { status: Number(failure), json: async () => ({ reason: "指定内容を確認してください。" }) }; }
            });
            const opening = view.find(node => node.props.text === "Channel Scan").props.onClick();
            const route = failure === "validation" ? "SKY" : "SAT";
            view.change("Route", route); view.flushEffects(); view.render();
            assert.equal(view.input("Channels").props.value, route === "SKY" ? "list" : "preset");
            await view.start();
            view.render();
            assert.equal(view.find(node => node.props.title === "Channel Scan").props.isOpen, true);
            resolveTuners({ ok: true, json: async () => [{ name: "sat", types: [route === "SKY" ? "SKY" : "BS"], routes: [route], command: "dvbv5-zap -a 0" }] });
            await opening;
            view.render(); view.flushEffects(); view.render();
            assert.equal(view.input("Channels").props.value, "dvbConf");
            assert.equal(view.requests.filter(request => request.method === "PUT").length, failure === "validation" ? 0 : 1);
        });
    }

    it("preserves a manually selected source after scan failure and late tuner config", async () => {
        let resolveTuners;
        const view = await mountChannels(undefined, async (url, init) => {
            if (url === "/api/config/tuners") { return new Promise(resolve => { resolveTuners = resolve; }); }
            if (init.method === "PUT") { return { status: 400, json: async () => ({ reason: "指定内容を確認してください。" }) }; }
        });
        const opening = view.find(node => node.props.text === "Channel Scan").props.onClick();
        view.change("Route", "SAT"); view.flushEffects(); view.render();
        view.change("Channels", "preset");
        await view.start();
        resolveTuners({ ok: true, json: async () => [{ name: "sat", types: ["BS"], routes: ["SAT"], command: "dvbv5-zap -a 0" }] });
        await opening;
        view.render(); view.flushEffects(); view.render();
        assert.equal(view.input("Channels").props.value, "preset");
    });

    it("shows invalid loaded relative TS values and blocks their save", async () => {
        for (const value of [16, 1.5]) {
            const view = await mountChannels([{ name: "Cable", type: "BS", channel: "C13", route: "CATV", tsmfRelTs: value }]);
            const field = view.input("TsmfRelTs");
            assert.equal(field.props.type, "number");
            assert.equal(field.props.min, 1);
            assert.equal(field.props.max, 15);
            assert.equal(field.props.value, String(value));
            assert.equal(view.find(node => node.props.label === "TsmfRelTs").props.intent, "danger");
            await view.find(node => node.props.children === "保存").props.onClick();
            assert.equal(view.requests.length, 0);
            view.change("TsmfRelTs", "15");
            assert.equal(view.find(node => node.props.label === "TsmfRelTs").props.intent, undefined);
            await view.find(node => node.props.children === "保存").props.onClick();
            assert.equal(JSON.parse(view.requests.find(item => item.method === "PUT").body)[0].tsmfRelTs, 15);
            view.requests.length = 0;
            view.change("TsmfRelTs", "");
            await view.find(node => node.props.children === "保存").props.onClick();
            assert.equal("tsmfRelTs" in JSON.parse(view.requests.find(item => item.method === "PUT").body)[0], false);
        }
    });
});

describe("TSMF/TLV EPG status backport", () => {
    it("publishes active TS and TLV networks once each", () => {
        const timerAccuracy = { last: 0, m1: [0], m5: [0], m15: [0] };
        const status = {
            epg: { 4: true, 6: false },
            epgByStream: { "32752/1": true, "32752/2": true, "4/1": true, "7/1": false },
            rpcCount: 0, streamCount: { tsFilter: 0, decoder: 0 }, errorCount: {}, timerAccuracy
        };
        const { getStatus } = loadSource("src/Mirakurun/api/status.ts", {
            "../api": {},
            "../status": { __esModule: true, default: status },
            "../_": { __esModule: true, default: { program: { itemMap: new Map() }, tuner: { devices: [] } } }
        });
        assert.deepEqual(getStatus().epg.gatheringNetworks, [4, 32752]);
        status.epgByStream["32752/1"] = false;
        assert.deepEqual(getStatus().epg.gatheringNetworks, [4, 32752]);
        status.epgByStream["32752/2"] = false;
        assert.deepEqual(getStatus().epg.gatheringNetworks, [4]);
    });
});

for (const [name, tuners, expected] of [
    ["empty", [], "list"], ["failed", null, "list"],
    ["non-dvb", [{ name: "sky", types: ["SKY"], command: "recpt1 --ch <channel>" }], "list"],
    ["remote", [{ name: "remote", types: ["SKY"], remoteMirakurunHost: "localhost", remoteMirakurunPort: 40772 }], "list"],
    ["remote-command", [{ name: "remote", types: ["SKY"], remoteMirakurunHost: "localhost", remoteMirakurunPort: 40772, command: "dvbv5-zap -a 0" }], "list"],
    ["mixed", [{ name: "dvb", types: ["SKY"], command: "dvbv5-zap -a 0" }, { name: "command", types: ["SKY"], command: "recpt1 --ch <channel>" }], "list"],
    ["dvb", [{ name: "dvb", types: ["SKY"], command: "dvbv5-zap -a 0" }], "dvbConf"]
]) {
    it(`uses a supported default scan source on SKY (${name})`, async () => {
        const view = await mountChannels(undefined, async url => {
            if (url === "/api/config/tuners") {
                if (tuners === null) { throw new Error("metadata unavailable"); }
                return { ok: true, json: async () => tuners };
            }
        });
        await view.find(node => node.props.text === "Channel Scan").props.onClick();
        view.change("Route", "SKY"); view.flushEffects(); view.render();
        assert.equal(view.input("Channels").props.value, expected);
        view.unmount();
    });
}
for (const typed of [false, true]) {
    it(`keeps a typed SKY list and updates only an empty default after late metadata (typed:${typed})`, async () => {
        let resolveTuners;
        const view = await mountChannels(undefined, async url => {
            if (url === "/api/config/tuners") { return new Promise(resolve => { resolveTuners = resolve; }); }
        });
        const opening = view.find(node => node.props.text === "Channel Scan").props.onClick();
        view.change("Route", "SKY"); view.flushEffects(); view.render();
        const before = view.input("Channels").props.value;
        if (typed) { view.change("Channel List (comma separated)", "1,2"); }
        resolveTuners({ ok: true, json: async () => [{ name: "dvb", types: ["SKY"], command: "dvbv5-zap -a 0" }] });
        await opening; view.render(); view.flushEffects(); view.render();
        assert.equal(before, "list");
        assert.equal(view.input("Channels").props.value, typed ? "list" : "dvbConf");
        if (typed) { assert.equal(view.input("Channel List (comma separated)").props.value, "1,2"); }
        view.unmount();
    });
}
for (const close of ["cancel", "accepted", "unmount"]) {
    it(`aborts an unused tuner-config read on dialog ${close}`, async () => {
        let signal;
        let active = 0;
        const view = await mountChannels(undefined, async (url, options) => {
            if (url === "/api/config/tuners") {
                signal = options.signal; active++;
                return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
                    active--; reject(new DOMException("closed tuner read", "AbortError"));
                }, { once: true }));
            }
        });
        const opening = view.find(node => node.props.text === "Channel Scan").props.onClick();
        view.render();
        assert.equal(active, 1);
        if (close === "cancel") { view.find(node => node.props.title === "Channel Scan").props.onClose(); }
        else if (close === "accepted") { await view.start(); }
        else { view.unmount(); }
        assert.equal(signal?.aborted, true);
        await opening; view.render();
        assert.equal(active, 0);
        assert.equal(elements(view.find(node => node.props.title === "Channel Scan"), node => node.props.title === "チューナー設定を取得できませんでした").length, 0);
        view.unmount();
    });
}
it("keeps at most one tuner-config read through repeated dialog opens", async () => {
    let active = 0, maximum = 0;
    const view = await mountChannels(undefined, async (url, options) => {
        if (url === "/api/config/tuners") {
            active++; maximum = Math.max(maximum, active);
            return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => {
                active--; reject(new DOMException("closed tuner read", "AbortError"));
            }, { once: true }));
        }
    });
    let opening;
    for (let index = 0; index < 3; index++) {
        opening = view.find(node => node.props.text === "Channel Scan").props.onClick();
        view.render();
        assert.equal(active, 1);
        view.find(node => node.props.title === "Channel Scan").props.onClose();
        assert.equal(active, 0);
        await opening; view.render();
    }
    assert.equal(maximum, 1);
    view.unmount();
});


describe("external TS playback backport", () => {
    function watch() {
        const copied = [], opened = [], anchors = [], blobs = [], revoked = [];
        const timers = [];
        const location = { protocol: "http:", host: "localhost:40772" };
        const { WatchButton } = loadSource("src/ui/components/WatchButton.tsx", {
            react: { ...React, useState: () => [false, () => {}], useEffect() {} },
            "../modules/common": { copyToClipboard: text => copied.push(text) },
            "../modules/state": { state: { serverConfig: { tsplayEndpoint: "https://player.example/", allowPNA: true } } }
        }, [], {
            location, console: silentConsole,
            window: { screenTop: 0, screenLeft: 0, innerHeight: 1000, innerWidth: 1400, open: (...args) => opened.push(args) },
            document: {
                createElement: () => ({ click() { this.clicked = true; } }),
                body: { appendChild: anchor => anchors.push(anchor), removeChild: anchor => anchors.splice(anchors.indexOf(anchor), 1) }
            },
            Blob: class { constructor(parts, options) { this.parts = parts; this.type = options.type; } },
            URL: { createObjectURL: blob => { blobs.push(blob); return "blob:watch-playlist"; }, revokeObjectURL: url => revoked.push(url) },
            setTimeout: callback => timers.push(callback)
        });
        const tree = WatchButton({ globalServiceId: 1100101 });
        const find = text => elements(tree, node => node.props.text === text)[0];
        return { copied, opened, anchors, blobs, revoked, timers, find };
    }
    it("copies an explicit TS service URL", () => {
        const view = watch();
        view.find("URL をクリップボードにコピー").props.onClick();
        assert.deepEqual(view.copied, ["http://localhost:40772/api/services/1100101/stream?format=ts"]);
    });
    it("downloads a TS playlist and releases its object URL", () => {
        const view = watch();
        view.find("M3U プレイリスト...").props.onClick();
        assert.equal(view.blobs.length, 1);
        assert.equal(view.blobs[0].type, "application/x-mpegURL");
        assert.equal(view.blobs[0].parts.join(""), "#EXTM3U\n#EXTINF:-1,\nhttp://localhost:40772/api/services/1100101/stream?format=ts\n");
        assert.equal(view.anchors[0].download, "Mirakurun_service_1100101.m3u8");
        assert.equal(view.anchors[0].clicked, true);
        view.timers[0]();
        assert.equal(view.anchors.length, 0);
        assert.deepEqual(view.revoked, ["blob:watch-playlist"]);
    });
    it("uses the same TS URL for the configured player", () => {
        const view = watch();
        view.find("視聴テスト").props.onPointerUp({ button: 0, ctrlKey: false });
        assert.equal(view.opened.length, 1);
        assert.equal(view.opened[0][0], "https://player.example/#http://localhost:40772/api/services/1100101/stream?format=ts");
    });
});


it("legacy Homeのプレイヤー起動にもTS形式を指定する", () => {
    const opened = [];
    const { ServicesSection } = loadSource("src/ui/routes/HomeView.tsx", {
        react: { ...React, useState: initial => [initial, () => {}] },
        "../modules/constants": constants,
        "../modules/state": { state: {} },
        "../modules/ui": {}
    }, ["ServicesSection"], {
        window: { open: (...args) => opened.push(args) },
        location: { protocol: "http:", host: "localhost:40772" }
    });
    const tree = ServicesSection({ services: [{ id: 1100101, type: 1 }],
        status: { epg: { gatheringNetworks: [] } }, allowPNA: true, tsplayEndpoint: "https://player.example/" });
    const play = elements(tree, node => node.props.title === "TSPlay (Experimental)");
    assert.equal(play.length, 1);
    play[0].props.onClick({ stopPropagation() {} });
    assert.equal(opened.length, 1);
    assert.equal(opened[0][0], "https://player.example/#http://localhost:40772/api/services/1100101/stream?decode=1&format=ts");
});

it("legacy Homeでも4Kテレビを視聴でき、データとその他は対象にしない", () => {
    const opened = [];
    const { ServicesSection } = loadSource("src/ui/routes/HomeView.tsx", {
        react: { ...React, useState: () => [true, () => {}] },
        "../modules/constants": constants,
        "../modules/state": { state: {} },
        "../modules/ui": {}
    }, ["ServicesSection"], {
        window: { open: (...args) => opened.push(args) },
        location: { protocol: "http:", host: "localhost:40772" }
    });
    const tree = ServicesSection({ services: [
        { id: 100001, type: 0x01 }, { id: 110001, type: 0xAD },
        { id: 100003, type: 0xC0 }, { id: 100004, type: 0x02 }
    ], status: { epg: { gatheringNetworks: [] } }, allowPNA: true, tsplayEndpoint: "https://player.example/" });
    const play = elements(tree, node => node.props.title === "TSPlay (Experimental)");
    assert.equal(play.length, 2);
    for (const button of play) { button.props.onClick({ stopPropagation() {} }); }
    assert.deepEqual(opened.map(args => args[0]), [
        "https://player.example/#http://localhost:40772/api/services/100001/stream?decode=1&format=ts",
        "https://player.example/#http://localhost:40772/api/services/110001/stream?decode=1&format=ts"
    ]);
});

for (const via of ["reconnect", "periodic-60s"]) {
    it(`[ui-service-index-empty] ${via}の空RPC一覧を通知して古い索引を消す`, async t => {
        const service = { id: 1100101, networkId: 11, serviceId: 101, name: "old service", type: 173,
            channel: { type: "BS4K", channel: "BS01_0" } };
        const f = mountServiceState([service]);
        t.after(() => f.close());
        await f.connected();
        const first = f.state.getService(11, 101);
        assert.equal(first.name, service.name);
        assert.equal(f.state.services[0], first);
        if (via === "reconnect") {
            f.rpc.emit("disconnect");
            assert.equal(f.state.getService(11, 101), first, "切断だけでは最後に確認したサービスを消しません");
            f.setServices([]);
            await f.connected();
        } else {
            f.setServices([]);
            const timer = f.timers.find(timer => timer.active && timer.milliseconds === 60000);
            assert.ok(timer, "実接続処理がサービスの定期取得を登録します");
            await timer.callback();
        }
        assert.deepEqual(f.state.services, []);
        assert.equal(f.state.getService(11, 101), undefined);
        assert.deepEqual(f.notifications, [[service.id], []]);
        assert.equal(f.requests.filter(method => method === "getServices").length, 2);
    });
}
