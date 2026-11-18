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
const { retainOutput } = require("../lib/Mirakurun/OutputBuffer");

it("retains shared input independently and copies only newly queued bytes", () => {
  const first = Buffer.alloc(1024, 1);
  const queue = [first];
  let bytes = retainOutput(queue, 0, first.length, 1024);
  first.fill(9);
  assert.deepEqual(queue[0], Buffer.alloc(1024, 1));
  const concat = Buffer.concat;
  let copied = 0;
  Buffer.concat = function (chunks, length) {
    copied += chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    return concat(chunks, length);
  };
  try {
    for (let i = 0; i < 20; i++) {
      const retained = queue.length;
      queue.push(Buffer.alloc(128, i));
      bytes = retainOutput(queue, retained, bytes + 128, 1024);
    }
  } finally {
    Buffer.concat = concat;
  }
  assert.equal(copied, 20 * 128);
  assert.equal(bytes, 1024);
  assert.deepEqual(Buffer.concat(queue), Buffer.concat(Array.from({ length: 8 }, (_, i) => Buffer.alloc(128, i + 12))));
});

it("discards the oldest chunks as a whole", () => {
  const queue = [Buffer.alloc(300, 1), Buffer.alloc(300, 2), Buffer.alloc(300, 3), Buffer.alloc(300, 4)];
  assert.equal(retainOutput(queue, 4, 1200, 1000, true), 900);
  assert.deepEqual(queue.map(chunk => chunk[0]), [2, 3, 4]);
  assert.equal(retainOutput(queue, 3, 900, 900, true), 900);
  // the newest chunk is retained even over the limit
  assert.equal(retainOutput(queue, 3, 900, 0, true), 300);
  assert.deepEqual(queue.map(chunk => chunk[0]), [4]);
});

it("handles an exact limit and complete eviction", () => {
  const queue = [Buffer.from("abcd")];
  assert.equal(retainOutput(queue, 0, 4, 4), 4);
  assert.equal(retainOutput(queue, 1, 4, 0), 0);
  assert.equal(queue.length, 0);
});
