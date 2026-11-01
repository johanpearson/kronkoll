/**
 * CSRF-skydd för ändrande anrop (KK-29-B, hot T-T1). Access-cookien skickas automatiskt av
 * webbläsaren, så ändrande anrop måste dessutom komma från vår egen origin och bära en egen
 * header som en främmande sida inte kan sätta utan CORS.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function checkCsrf(request: Request, expectedOrigin: string): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  return request.headers.get("origin") === expectedOrigin && request.headers.get("x-kronkoll") === "1";
}
