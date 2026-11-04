// Ritar appens PNG-ikoner från public/icons/icon.svg med Chromium från Playwright. Körs för hand när
// ikonen ändras: node scripts/icons.ts (i apps/web). Maskable- och iOS-ikonen har ingen egen rundning,
// eftersom telefonen skär till dem själv, och märket ligger inom den säkra zonen (80 %).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = new URL("../public/icons/", import.meta.url);
const svg = readFileSync(new URL("icon.svg", dir), "utf8");
const fullBleed = svg.replace(' rx="112"', "");

const icons = [
  { file: "icon-192.png", size: 192, source: svg },
  { file: "icon-512.png", size: 512, source: svg },
  { file: "maskable-512.png", size: 512, source: fullBleed },
  { file: "apple-touch-icon.png", size: 180, source: fullBleed },
];

const browser = await chromium.launch();
try {
  for (const { file, size, source } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>*{margin:0}svg{display:block;width:100vw;height:100vh}</style>${source}`);
    await page.screenshot({ path: fileURLToPath(new URL(file, dir)), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
