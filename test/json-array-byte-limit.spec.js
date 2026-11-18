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
const http = require("node:http");
const { responseJSON } = require("../lib/Mirakurun/api");

// 要素の途中では分割せず、少数の配列をまとめる上限だけをUTF-8の送信量で確認する。
describe("[json-array-byte-limit.spec] JSON配列の書込み量", () => {
    for (const [name, text, count, largeElement] of [
        ["日本語", "番".repeat(1024), 64, false],
        ["サロゲートペア", "📺".repeat(1024), 48, false],
        ["小さな日本語一覧", "番".repeat(512), 32, false],
        ["小さなASCII一覧", "a".repeat(512), 32, false],
        ["単体で上限を超える要素", "番".repeat(64 * 1024), 1, true]
    ]) {
        it(`${name}を壊さずUTF-8の上限でまとめる`, { timeout: 10000 }, async t => {
            const body = Array.from({ length: count }, (_, id) => ({ id, name: text }));
            const expected = JSON.stringify(body);
            const bytes = Buffer.byteLength(expected);
            const writes = [];
            const server = http.createServer((_req, res) => {
                const write = res.write;
                const end = res.end;
                res.status = code => { res.statusCode = code; return res; };
                res.write = function (chunk, ...args) {
                    writes.push(Buffer.byteLength(chunk));
                    return write.call(this, chunk, ...args);
                };
                res.end = function (chunk, ...args) {
                    if (chunk !== undefined) { writes.push(Buffer.byteLength(chunk)); }
                    return end.call(this, chunk, ...args);
                };
                void responseJSON(res, body).catch(error => res.destroy(error));
            });
            await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
            t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
            const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(5000) });
            assert.equal(response.status, 200);
            assert.equal(await response.text(), expected);
            assert.equal(writes.reduce((sum, value) => sum + value, 0), bytes);
            if (largeElement) {
                assert.ok(writes.some(length => length >= Buffer.byteLength(JSON.stringify(body[0]))), "大きな要素もJSONの途中で分割しない");
            } else if (bytes > 128 * 1024) {
                assert.ok(expected.length < 128 * 1024, "文字数だけでは送信量を判定できない入力");
                assert.ok(writes.length > 1, "上限を超える一覧は複数回に分ける");
                assert.ok(writes.every(length => length <= 128 * 1024), `書込み量: ${writes.join(",")}`);
                assert.equal(response.headers.get("content-length"), null);
            } else {
                assert.deepEqual(writes, [bytes]);
                assert.equal(response.headers.get("content-length"), String(bytes));
            }
        });
    }
});
