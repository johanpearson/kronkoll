// Visa träffar för en sparad regel (#251, KK-18-C): transaktionerna regeln gäller, nyast först, och vad som händer med var
// och en om den appliceras. Manuellt valda märks och ändras aldrig. Bankens text visas som text (KK-30).
import { useEffect, useState } from "react";
import { getJson } from "../api.ts";
import { Skeleton } from "../ui/Surface.tsx";
import { HitList, summary, toHits, type Hits } from "./RuleHits.tsx";

async function fetchMatches(ruleId: string): Promise<Hits | null> {
  const { status, body } = await getJson(`/api/rules/${encodeURIComponent(ruleId)}/matches`);
  return status === 200 ? toHits(body) : null;
}

export function RuleMatches({ ruleId }: { ruleId: string }) {
  const [matches, setMatches] = useState<Hits | null | "error">(null);

  useEffect(() => {
    let current = true;
    void fetchMatches(ruleId).then((loaded) => {
      if (current) setMatches(loaded ?? "error");
    });
    return () => {
      current = false;
    };
  }, [ruleId]);

  if (matches === null) return <Skeleton lines={3} />;
  if (matches === "error") {
    return (
      <p role="alert" className="ui-field-error">
        Det gick inte att hämta träffarna.
      </p>
    );
  }
  return (
    <div className="ui-stack">
      <p className="ui-body">
        {summary(matches)}
        {matches.items.length > 0 && matches.items.length < matches.total ? ` Visar de ${String(matches.items.length)} senaste.` : ""}
      </p>
      {matches.items.length > 0 && <HitList label="Träffar" hits={matches.items} />}
    </div>
  );
}
