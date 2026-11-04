// Bygger webbappen till dist/ (D-frontend). Filerna i public/ (säkerhetsheaders, robots.txt,
// manifest och ikoner) kopieras som de är. Inga inline-skript, så den strikta CSP:n gäller oförändrad (KK-30).
// Service workern byggs som en egen fil, /sw.js utan hash, så att webbläsaren hittar den (KK-25-A).
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      input: { main: file("index.html"), sw: file("src/sw/sw.ts") },
      output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
    },
  },
});
