const { describe, it } = require("node:test");
const assert = require("assert");
const sift = require("sift");

const { Program } = require("../lib/Mirakurun/Program");

function programStore(items) {
  const program = Object.create(Program.prototype);
  program._itemMap = new Map(items.map(item => [item.id, item]));
  return program;
}

describe("[program.spec] Program.ts: findByQuery()", () => {
  const items = [];
  for (let i = 0; i < 60; i++) {
    items.push({ id: i, networkId: 32736 + (i % 2), serviceId: 1024 + (i % 3), eventId: i % 7, name: `p${i}` });
  }
  const store = programStore(items);

  it("returns the same programs as sift for networkId / serviceId / eventId", () => {
    const queries = [
      { networkId: 32736 },
      { serviceId: 1025 },
      { eventId: 3 },
      { networkId: 32737, serviceId: 1026 },
      { networkId: 32736, serviceId: 1024, eventId: 6 },
      { networkId: 1 }
    ];
    for (const query of queries) {
      const expected = items.filter(sift(query));
      assert.deepStrictEqual(store.findByQuery({ ...query }), expected, JSON.stringify(query));
    }
  });

  it("uses sift for other conditions", () => {
    assert.deepStrictEqual(store.findByQuery({ name: "p5" }), [items[5]]);
    assert.deepStrictEqual(store.findByQuery({ serviceId: "1024" }), items.filter(sift({ serviceId: "1024" })));
    assert.deepStrictEqual(store.findByQuery({ serviceId: 1024, name: "p3" }), [items[3]]);
  });
});
