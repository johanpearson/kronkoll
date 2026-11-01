// Tunn proxy för /api/* (D-origin): skickar anropet oförändrat till API-workern via service
// binding och lägger på säkerhetsheaders. Access-token (Cf-Access-Jwt-Assertion) följer med.
import { withApiSecurityHeaders } from "../../server/security-headers.ts";

export interface Env {
  API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) =>
  withApiSecurityHeaders(await env.API.fetch(request));
