// GET /api/categories (KK-18-A, #32): kategorierna med förälder, så att appen kan visa namn som
// "Mat › Livsmedel" och senare låta användaren välja kategori.
import { categoryRepository } from "@kronkoll/adapter-d1";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function listCategories(env: { DB: D1Database }): Promise<Response> {
  try {
    const rows = await categoryRepository(env.DB).list();
    const items = rows.map((c) => ({ id: c.id, parent_id: c.parentId, name: c.name, kind: c.kind, archived: c.archived }));
    return json({ items }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
