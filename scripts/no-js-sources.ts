// KK-3: all källkod är TypeScript. Stoppar .js/.mjs/.cjs-filer i repot.
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "*.js", "*.mjs", "*.cjs"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f !== "");

if (files.length > 0) {
  console.error(`JavaScript-källfiler är inte tillåtna (KK-3):\n${files.join("\n")}`);
  process.exit(1);
}
console.log("Inga JavaScript-källfiler.");
