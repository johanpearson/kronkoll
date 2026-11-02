/**
 * Engångs-state för bankflödet (KK-29-A, hot T-S2). Callbacken från banken är ett klassiskt mål
 * för CSRF och för att injicera någon annans koppling, och Access-cookien skyddar inte mot det.
 * Därför gäller:
 * - state är `<id>.<HMAC>`: ett slumpat id och dess HMAC-SHA-256. En förfalskad eller ändrad
 *   sträng avvisas på signaturen, innan databasen ens frågas.
 * - raden i databasen binder id:t till användaren och kopplingen, och ger 15 minuters giltighet.
 * - raden används en gång. Förbrukningen är en enda UPDATE med villkoren, så två samtidiga
 *   anrop kan aldrig båda lyckas, och ett anrop från fel användare förbrukar ingenting.
 * Bara id:t sparas, aldrig den signerade strängen.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Keys } from "./crypto.ts";
import { connectStates } from "./schema.ts";

export const STATE_TTL_MINUTES = 15;

const ID_PATTERN = /^[0-9a-f]{32}$/u;
const SIGNATURE_BYTES = 32;
const CONTEXT = "kronkoll/connect-state/v1:";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const message = (id: string) => new TextEncoder().encode(`${CONTEXT}${id}`);

async function sign(keys: Keys, id: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", keys.stateKey, message(id))));
}

/** Id:t om signaturen stämmer, annars null. Jämförelsen sker i konstant tid av WebCrypto. */
async function verifiedId(keys: Keys, state: string): Promise<string | null> {
  const parts = state.split(".");
  const [id, signature] = parts;
  if (parts.length !== 2 || id === undefined || signature === undefined || !ID_PATTERN.test(id)) return null;
  const bytes = fromBase64Url(signature);
  if (bytes?.length !== SIGNATURE_BYTES) return null;
  return (await crypto.subtle.verify("HMAC", keys.stateKey, bytes, message(id))) ? id : null;
}

export function connectStateRepository(d1: D1Database, keys: Keys) {
  const db = drizzle(d1);
  return {
    /** Utfärdar ett state för en koppling som väntar på godkännande hos banken. */
    async issue(input: { connectionId: string; userId: string; now: Date }): Promise<{ state: string; expiresAt: string }> {
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const expiresAt = new Date(input.now.getTime() + STATE_TTL_MINUTES * 60_000).toISOString();
      await db.insert(connectStates).values({ id, connectionId: input.connectionId, userId: input.userId, expiresAt });
      return { state: `${id}.${await sign(keys, id)}`, expiresAt };
    },

    /**
     * Förbrukar ett state och ger kopplingen det hör till, eller null om det är förfalskat,
     * utgånget, redan använt eller utfärdat åt någon annan.
     */
    async consume(input: { state: string; userId: string; now: Date }): Promise<{ connectionId: string } | null> {
      const id = await verifiedId(keys, input.state);
      if (id === null) return null;
      const now = input.now.toISOString();
      const [row] = await db
        .update(connectStates)
        .set({ usedAt: now })
        .where(and(eq(connectStates.id, id), eq(connectStates.userId, input.userId), isNull(connectStates.usedAt), gt(connectStates.expiresAt, now)))
        .returning({ connectionId: connectStates.connectionId })
        .all();
      return row ?? null;
    },

    /** Tar bort utgångna och använda state. Returnerar antal borttagna. */
    async purge(now: Date): Promise<number> {
      const removed = await db
        .delete(connectStates)
        .where(or(lte(connectStates.expiresAt, now.toISOString()), isNotNull(connectStates.usedAt)))
        .returning({ id: connectStates.id })
        .all();
      return removed.length;
    },
  };
}
