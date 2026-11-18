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
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true,
    default: { epg: {}, epgByStream: {}, streamCount: {}, errorCount: {} } } };
const _ = require("../lib/Mirakurun/_").default;
const log = require("../lib/Mirakurun/log");
const db = require("../lib/Mirakurun/db");
const Channel = require("../lib/Mirakurun/Channel").default;
const Service = require("../lib/Mirakurun/Service").default;
const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
it("[service-source-channel.spec] JSON保存元を元チャンネルに保ち、API経路と分けて復元する", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const level of ["info", "debug", "warn", "error"]) { t.mock.method(log, level, () => {}); }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mirakurun-service-source-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const previous = { services: process.env.SERVICES_DB_PATH, channels: process.env.CHANNELS_DB_PATH };
    t.after(() => {
        for (const [key, value] of [["SERVICES_DB_PATH", previous.services], ["CHANNELS_DB_PATH", previous.channels]]) {
            if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
        }
    });
    process.env.SERVICES_DB_PATH = path.join(dir, "services.json");
    process.env.CHANNELS_DB_PATH = path.join(dir, "channels.json");
    _.config = { server: { disableEITParsing: true }, channels: [
        { name: "original", type: "GR", channel: "27", route: "TER" },
        { name: "relay", type: "GR", channel: "C27", route: "CATV" }
    ] };
    _.configIntegrity = { channels: "service-source" };
    _.event = { emit: () => true };
    _.tuner = { typeExists: () => true };
    _.service = new Service(); _.channel = new Channel();
    const [primary, relay] = _.channel.items;
    relay.setStreams([{ networkId: 32752, streamId: 12345, format: "ts" }]);
    const item = new ServiceItem(primary, 32752, 1024, "Program service", 1, -1, 1, true, 123456789, 12345, true);
    _.service.add(item);
    assert.equal(item.channel, relay);
    const save = db.saveServices;
    let writing;
    t.mock.method(db, "saveServices", (...args) => writing = save(...args));
    _.service._save(); await writing;
    const stored = JSON.parse(await fs.readFile(process.env.SERVICES_DB_PATH, "utf8"))[1];
    assert.deepEqual(stored.channel, { type: "GR", channel: "27", route: "TER" });
    assert.equal(Object.hasOwn(stored, "channels"), false);
    assert.deepEqual(item.export().channel, { type: "GR", channel: "C27", route: "CATV" });
    _.config.channels = [_.config.channels[0]];
    _.channel = new Channel(); _.service = new Service();
    // JSON DB自身の整合性検査の契約は変えず、保存する元チャンネルを検証します。
    await _.service.load();
    const restored = _.service.get(32752, 1024);
    assert.ok(restored);
    assert.equal(restored.channel.channel, "27");
    assert.equal(restored.epgReady, true);
    assert.equal(restored.epgUpdatedAt, 123456789);
    assert.equal(restored.streamId, 12345);
});
