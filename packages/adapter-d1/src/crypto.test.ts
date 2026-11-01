import { describe, expect, it } from "vitest";
import { decryptSessionId, deriveKeys, encryptSessionId, hashIban, maskAccountName } from "./crypto.ts";
import { randomSecret } from "./test-support.ts";

// Bankernas dokumenterade exempel-IBAN, inte ett riktigt konto (KK-13).
const IBAN = "SE45 5000 0000 0583 9825 7466";

describe("session-id krypteras med AES-GCM (KK-11-C)", () => {
  it("går att dekryptera med samma nyckel", async () => {
    const keys = await deriveKeys(randomSecret());
    expect(await decryptSessionId(keys, await encryptSessionId(keys, "eb-session-1"))).toBe("eb-session-1");
  });

  it("ger olika chiffertext varje gång och innehåller aldrig klartexten", async () => {
    const keys = await deriveKeys(randomSecret());
    const a = await encryptSessionId(keys, "eb-session-1");
    const b = await encryptSessionId(keys, "eb-session-1");
    expect(a).not.toEqual(b);
    expect(new TextDecoder().decode(a)).not.toContain("eb-session-1");
  });

  it("avvisar ändrad chiffertext, fel nyckel och okänt format", async () => {
    const keys = await deriveKeys(randomSecret());
    const sealed = await encryptSessionId(keys, "eb-session-1");
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    await expect(decryptSessionId(keys, tampered)).rejects.toThrow();
    await expect(decryptSessionId(await deriveKeys(randomSecret()), sealed)).rejects.toThrow();
    await expect(decryptSessionId(keys, Uint8Array.of(9, ...sealed.slice(1)))).rejects.toThrow(RangeError);
    await expect(decryptSessionId(keys, Uint8Array.of(1))).rejects.toThrow(RangeError);
  });

  it("kräver en hemlighet på minst 32 byte i base64", async () => {
    await expect(deriveKeys(btoa("för kort"))).rejects.toThrow(RangeError);
    await expect(deriveKeys("inte base64!!")).rejects.toThrow(RangeError);
  });
});

describe("IBAN sparas bara som HMAC (KK-8-B)", () => {
  it("är stabil, oberoende av mellanslag och gemener, och avslöjar inte kontonumret", async () => {
    const keys = await deriveKeys(randomSecret());
    const hash = await hashIban(keys, IBAN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashIban(keys, IBAN.replace(/\s/gu, "").toLowerCase())).toBe(hash);
    expect(hash).not.toContain("58398257466");
  });

  it("ger en annan hash med en annan nyckel, så att den inte går att slå upp i förväg", async () => {
    expect(await hashIban(await deriveKeys(randomSecret()), IBAN)).not.toBe(await hashIban(await deriveKeys(randomSecret()), IBAN));
  });
});

describe("maskerat kontonamn", () => {
  it("visar bara de fyra sista siffrorna", () => {
    expect(maskAccountName("Privatkonto", IBAN)).toBe("Privatkonto ••7466");
  });

  it("tar bort kontonummer som banken har lagt i namnet", () => {
    expect(maskAccountName("Sparkonto 9150-123 456 7", null)).toBe("Sparkonto");
    expect(maskAccountName("91501234567", IBAN)).toBe("Konto ••7466");
  });
});
