// Bygger webbappen till dist/ (D-frontend). Filerna i public/ (säkerhetsheaders, robots.txt,
// stilmall) kopieras som de är. Inga inline-skript, så den strikta CSP:n gäller oförändrad (KK-30).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
