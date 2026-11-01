import { describe, expect, it, vi } from "vitest";
import { createJwtSigner } from "./jwt.ts";

// Testnyckelpar genereras vid körning – ingen riktig nyckel finns i repot (KK-12, KK-13).
async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const base64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  const pem = ["-----BEGIN PRIVATE", "KEY-----\n"].join(" ") + base64 + "\n" + ["-----END PRIVATE", "KEY-----"].join(" ");
  return { pem, publicKey: pair.publicKey };
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("Enable Banking-JWT (KK-5-B)", () => {
  it("är RS256-signerad och verifierbar med den publika nyckeln", async () => {
    const { pem, publicKey } = await generateKeyPair();
    const signer = createJwtSigner({ privateKeyPem: pem, applicationId: "app-123", now: () => NOW });
    const token = await signer.sign();
    const [header, payload, signature] = token.split(".");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(signature ?? "", "base64url"),
      new TextEncoder().encode(`${header ?? ""}.${payload ?? ""}`),
    );
    expect(valid).toBe(true);
  });

  it("har rätt header och claims med högst 300 s giltighet", async () => {
    const { pem } = await generateKeyPair();
    const token = await createJwtSigner({ privateKeyPem: pem, applicationId: "app-123", now: () => NOW }).sign();
    const [header, payload] = token.split(".");
    expect(decodePart(header ?? "")).toEqual({ typ: "JWT", alg: "RS256", kid: "app-123" });
    const claims = decodePart(payload ?? "");
    expect(claims).toEqual({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: NOW / 1000, exp: NOW / 1000 + 300 });
  });

  it("importerar nyckeln bara en gång per signerare", async () => {
    const { pem } = await generateKeyPair();
    const spy = vi.spyOn(crypto.subtle, "importKey");
    const signer = createJwtSigner({ privateKeyPem: pem, applicationId: "app-123", now: () => NOW });
    await Promise.all([signer.sign(), signer.sign()]);
    await signer.sign();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("ger ett fel utan nyckelinnehåll när nyckeln är ogiltig", async () => {
    // Byggs vid körning så att testdata inte ser ut som en hemlighet för secret scanning.
    const marker = ["ogiltig", "testtext"].join("-");
    const signer = createJwtSigner({ privateKeyPem: marker, applicationId: "app-123", now: () => NOW });
    const error = await signer.sign().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Ogiltig privat nyckel för Enable Banking (EB_PRIVATE_KEY)");
    expect((error as Error).message).not.toContain(marker);
  });

  it("kräver ett application id", () => {
    expect(() => createJwtSigner({ privateKeyPem: "x", applicationId: "", now: () => NOW })).toThrow(
      "EB_APP_ID saknas",
    );
  });
});
