// En huvudkategori (#251, KK-18-A): dess underkategorier som listrader. Ett tryck på en rad öppnar ett ark
// med åtgärderna. Huvudkategorin ändras med knappen i sidhuvudet. Är den arkiverad eller ihopslagen
// säger sidan det, och tillbakaknappen leder till listan.
import { sortCategories } from "@kronkoll/domain";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { CategoryDot } from "../category-color.tsx";
import { useToast } from "../toast.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { EmptyState, Skeleton } from "../ui/Surface.tsx";
import { CategorySheet, useCategories, type Target } from "./category-sheet.tsx";

const DONE: Record<string, string> = { archive: "arkiverad", merge: "ihopslagen" };

export function CategoryView({ id }: { id: string }) {
  const toast = useToast();
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const categories = useCategories(reload);

  if (categories === null) return <main><Skeleton lines={4} /></main>;
  if (categories === "error") return <main><p role="alert">Det gick inte att hämta kategorierna. Försök igen om en stund.</p></main>;
  const main = categories.find((c) => c.id === id && c.parentId === null);
  if (main === undefined) return <main><EmptyState title="Kategorin finns inte">Den kan vara arkiverad eller ihopslagen med en annan.</EmptyState></main>;

  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  const subs = sortCategories(categories.filter((c) => c.parentId === id));
  return (
    <main>
      <div className="page-header">
        <h1>
          <CategoryDot categoryId={main.id} parentOf={parentOf} />
          {main.name}
        </h1>
        <IconButton label={`Ändra ${main.name}`} icon={Pencil} onClick={() => { setTarget({ category: main, mode: "menu" }); }} />
      </div>
      {subs.length === 0 ? (
        <p className="ui-body">Inga underkategorier än.</p>
      ) : (
        <List label="Underkategorier">
          {subs.map((s) => (
            <ListRow key={s.id} label={s.name} onClick={() => { setTarget({ category: s, mode: "menu" }); }} />
          ))}
        </List>
      )}
      <Button variant="primary" block icon={Plus} onClick={() => { setTarget({ category: main, mode: "add" }); }}>
        Ny underkategori
      </Button>
      <CategorySheet
        target={target}
        categories={categories}
        onTarget={setTarget}
        onChanged={(mode) => {
          const done = DONE[mode];
          if (done !== undefined && target?.category) toast.done(`${target.category.name} är ${done}.`);
          // Flytta upp och ner lämnar arket öppet, så att man kan flytta flera steg.
          if (mode !== "move") setTarget(null);
          setReload((n) => n + 1);
        }}
      />
    </main>
  );
}
