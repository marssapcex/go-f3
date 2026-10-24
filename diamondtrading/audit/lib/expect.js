// Minimal chai-like expect() on top of node:assert (keeps the audit harness dependency-free).
const assert = require("node:assert/strict");
function expect(actual) {
  const check = (ok, msg) => { if (!ok) assert.fail(msg); };
  const api = {
    equal: (e) => { assert.equal(actual, e, `expected ${String(actual)} to equal ${String(e)}`); },
    eq: (e) => { assert.equal(actual, e); },
    deep: { equal: (e) => assert.deepEqual(actual, e) },
    gt: (e) => check(actual > e, `expected ${actual} > ${e}`),
    gte: (e) => check(actual >= e, `expected ${actual} >= ${e}`),
    lt: (e) => check(actual < e, `expected ${actual} < ${e}`),
    lte: (e) => check(actual <= e, `expected ${actual} <= ${e}`),
    true: () => assert.equal(actual, true),
    false: () => assert.equal(actual, false),
    ok: () => assert.ok(actual),
  };
  api.to = api; api.be = api; api.been = api;
  return api;
}
module.exports = { expect };
