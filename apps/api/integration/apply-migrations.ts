import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Körs före varje testfil. Redan körda migreringar hoppas över.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
