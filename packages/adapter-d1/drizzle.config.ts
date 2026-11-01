// Genererar SQL-migreringar från schemat (D-orm). Migreringarna körs sedan med
// `wrangler d1 migrations apply`, lokalt och i deploy-flödet.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
