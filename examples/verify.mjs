import fs from "node:fs/promises";
import assert from "node:assert/strict";
const values = JSON.parse(
  await fs.readFile("example-output/result.json", "utf8"),
);
const reference = JSON.parse(
  await fs.readFile("example-output/reference.json", "utf8"),
);
assert.deepEqual(values, reference);
assert.equal(values.length, 101);
assert.equal(values[100], 5050);
console.log("101 generated values match an independent closed-form reference.");
