// Skapar ett VAPID-nyckelpar för Web Push (KK-27, D-notify). Kör en gång från repots rot:
// `node scripts/vapid-keys.ts`. Sätt sedan båda som secrets på workern kronkoll-api, i Cloudflares
// kontrollpanel eller med `npx wrangler secret put VAPID_PUBLIC_KEY` och `… VAPID_PRIVATE_KEY` i
// apps/api, och spara den privata i Bitwarden. Aldrig i repot (KK-12).
// Byts nycklarna måste varje enhet slå på notiserna igen.
export {};

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${d ?? ""}`);
