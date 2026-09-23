import fs from "node:fs/promises";
await fs.mkdir("example-output", { recursive: true });
await fs.writeFile(
  "example-output/reference.json",
  JSON.stringify(Array.from({ length: 101 }, (_, n) => (n * (n + 1)) / 2)) +
    "\n",
);
