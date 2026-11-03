import type { D1Migration } from "cloudflare:test";
import type { Env as ApiEnv } from "../src/index.ts";

// Typerna för `env` och `exports` från "cloudflare:workers" i testerna.
declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index.ts");
    }
  }
}
