// KK-5-A: Kronkoll får bara läsa från banken. Stoppar all kod som refererar till
// betalnings-endpoints hos Enable Banking (t.ex. "/payments").
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FORBIDDEN = /\/payments\b|payment[-_]?initiation/i;

const files = execFileSync("git", ["ls-files", "packages/*/src/**", "apps/*/src/**", "apps/*/functions/**", "apps/*/server/**"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

const hits = files.filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));

if (hits.length > 0) {
  console.error(`Betalnings-endpoints är förbjudna, Kronkoll får bara läsa (KK-5-A):\n${hits.join("\n")}`);
  process.exit(1);
}
console.log(`Inga betalnings-endpoints i ${String(files.length)} källfiler.`);
