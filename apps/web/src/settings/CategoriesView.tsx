// Kategorier (#251, KK-18-A): huvudkategorierna per typ som listrader med färgprick (KK-26-D) och antal
// underkategorier. En rad leder till huvudkategorins undervy. Ny huvudkategori läggs till i ett ark.
// Arkiverade visas inte.
import { sortCategories } from "@kronkoll/domain";
import { Plus } from "lucide-react";
import { useState } from "react";
import { CategoryDot } from "../category-color.tsx";
import { Button } from "../ui/Button.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { EmptyState, Skeleton } from "../ui/Surface.tsx";
import { CategorySheet, useCategories, type Target } from "./category-sheet.tsx";
import { ResetCategories } from "./ResetCategories.tsx";

const KINDS = [
  { kind: "expense", title: "Utgifter" },
  { kind: "income", title: "Inkomster" },
  { kind: "transfer", title: "Överföringar" },
];

const subcount = (n: number) => (n === 0 ? "Inga underkategorier" : n === 1 ? "1 underkategori" : `${String(n)} underkategorier`);

export function CategoriesView() {
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const categories = useCategories(reload);

  if (categories === null) return <main><h1>Kategorier</h1><Skeleton lines={6} /></main>;
  if (categories === "error") return <main><h1>Kategorier</h1><p role="alert">Det gick inte att hämta kategorierna. Försök igen om en stund.</p></main>;

  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  return (
    <main>
      <h1>Kategorier</h1>
      {KINDS.map(({ kind, title }) => {
        const mains = sortCategories(categories.filter((c) => c.kind === kind && c.parentId === null));
        if (mains.length === 0) return null;
        return (
          <section key={kind}>
            <h2>{title}</h2>
            <List label={title}>
              {mains.map((m) => (
                <ListRow
                  key={m.id}
                  label={
                    <>
                      <CategoryDot categoryId={m.id} parentOf={parentOf} />
                      {m.name}
                    </>
                  }
                  detail={subcount(categories.filter((c) => c.parentId === m.id).length)}
                  to={`/installningar/kategorier/${encodeURIComponent(m.id)}`}
                />
              ))}
            </List>
          </section>
        );
      })}
      {categories.length === 0 && <EmptyState title="Inga kategorier">Det finns inga kategorier. Lägg till en huvudkategori för att komma igång.</EmptyState>}
      <Button variant="primary" block icon={Plus} onClick={() => { setTarget({ category: null, mode: "add" }); }}>
        Ny huvudkategori
      </Button>
      <CategorySheet
        target={target}
        categories={categories}
        onTarget={setTarget}
        onChanged={(mode) => {
          // Flytta upp och ner lämnar arket öppet, så att man kan flytta flera steg.
          if (mode !== "move") setTarget(null);
          setReload((n) => n + 1);
        }}
      />
      <ResetCategories onDone={() => { setTarget(null); setReload((n) => n + 1); }} />
    </main>
  );
}
