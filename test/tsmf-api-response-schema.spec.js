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
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const Ajv = require("ajv");
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
const document = yaml.load(fs.readFileSync(process.env.MIRAKURUN_TSMF_SCHEMA_PATH || path.join(__dirname, "../api.yml"), "utf8"));
const schemas = document.components?.schemas || document.definitions;
const resolve = field => field?.$ref ? schemas[field.$ref.split("/").at(-1)] : field;
const ajv = new Ajv();

it("[tsmf-api-response-schema.spec] 管理者向けChannelの形式と設定グループを定義する", () => {
    const properties = schemas.Channel.properties;
    assert.ok(properties.format, "formatの定義が必要です");
    assert.ok(properties.tsmfGroupId, "tsmfGroupIdの定義が必要です");
    const validate = ajv.compile({ type: "object", required: ["format", "tsmfGroupId"], properties: {
        format: resolve(properties.format), tsmfGroupId: resolve(properties.tsmfGroupId)
    } });
    for (const format of ["ts", "tlv"]) {
        for (const tsmfGroupId of [1, 255]) {
            const channel = new ChannelItem({ name: "fixture", type: "BS4K", channel: "C19", route: "CATV", format, tsmfGroupId }).toJSON();
            assert.equal(validate(channel), true, JSON.stringify(validate.errors));
        }
    }
    assert.equal(validate({ format: "invalid", tsmfGroupId: 1 }), false);
    assert.equal(validate({ format: "ts", tsmfGroupId: 256 }), false);
});

it("[tsmf-api-response-schema.spec] TunerUserの実際の出力形式を宣言する", () => {
    const outputFormat = schemas.TunerUser.properties.outputFormat;
    assert.ok(outputFormat, "outputFormatの定義が必要です");
    const validate = ajv.compile(resolve(outputFormat));
    assert.equal(validate("ts"), true);
    assert.equal(validate("tlv"), true);
    assert.equal(validate("invalid"), false);
});
