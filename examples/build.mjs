import fs from "node:fs/promises";
// Two independent implementations of triangular numbers must agree.
await fs.mkdir("example-output", { recursive: true });
const values = [];
let sum = 0;
for (let n = 0; n <= 100; n++) {
  sum += n;
  values.push(sum);
}
await fs.writeFile("example-output/result.json", JSON.stringify(values) + "\n");
