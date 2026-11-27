// Kontofilter (KK-41-C): `?account=acc_1&account=acc_2` på Transaktioner, Budget och Insikter. Utan
// parameter visas alla konton. Antalet är begränsat eftersom D1 tillåter högst 100 parametrar per fråga.
export const MAX_FILTER_ACCOUNTS = 10;
const MAX_ID_LENGTH = 64;

/**
 * Kontona ur adressen, utan dubbletter. Undefined när inget filter är satt och null när ett id är
 * tomt eller för långt eller när det är för många konton.
 */
export function readAccountFilter(url: URL): string[] | null | undefined {
  const ids = url.searchParams.getAll("account");
  if (ids.length === 0) return undefined;
  const unique = [...new Set(ids)];
  if (unique.length > MAX_FILTER_ACCOUNTS || unique.some((id) => id === "" || id.length > MAX_ID_LENGTH)) return null;
  return unique;
}
