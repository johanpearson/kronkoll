// Varför den här kategorin? (#251, KK-58-D): vad som gav transaktionen sin kategori, ett eget val eller en regel, och vilka
// andra regler som också träffar den, i den ordning de vinner. Svaret kommer färdigt från API:t (`category_reason`). En regel
// pekas bara ut när den vinner nu och ger samma kategori, så förklaringen skyller aldrig på fel regel efter en ändring.
import { useState } from "react";
import { field } from "../api.ts";
import { Button } from "../ui/Button.tsx";
import { List, ListRow } from "../ui/ListRow.tsx";
import { Sheet } from "../ui/Modal.tsx";

export interface ReasonRule {
  readonly id: string;
  readonly contains: boolean;
  readonly pattern: string;
  readonly categoryId: string;
  readonly own: boolean;
}

export interface Reason {
  /** Varifrån kategorin kommer: manual, learned, template eller none. */
  readonly source: string;
  /** Regeln som ger kategorin nu, eller null. */
  readonly rule: ReasonRule | null;
  /** Andra regler som också träffar, i den ordning de vinner. */
  readonly alsoMatched: readonly ReasonRule[];
}

function toRule(raw: unknown): ReasonRule | null {
  const id = field(raw, "id");
  const pattern = field(raw, "pattern");
  const categoryId = field(raw, "category_id");
  if (typeof id !== "string" || typeof pattern !== "string" || typeof categoryId !== "string") return null;
  return { id, contains: field(raw, "match") === "description_contains", pattern, categoryId, own: field(raw, "source") === "learned" };
}

/** Förklaringen i svaret på GET /api/transactions/{id}, eller null om svaret inte har någon. */
export function toReason(raw: unknown): Reason | null {
  const source = field(raw, "source");
  if (typeof source !== "string") return null;
  const matched = field(raw, "also_matched");
  return {
    source,
    rule: toRule(field(raw, "rule")),
    alsoMatched: Array.isArray(matched) ? matched.flatMap((r) => toRule(r) ?? []) : [],
  };
}

export function CategoryReason(props: { reason: Reason; /** Kategorinamn per id, t.ex. "Mat › Livsmedel". */ names: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const { reason } = props;
  const text = (r: ReasonRule) => `${r.contains ? "Innehåller" : "Börjar med"} ${r.pattern} → ${props.names.get(r.categoryId) ?? r.categoryId}`;

  let explanation: string;
  if (reason.source === "manual") explanation = "Du valde kategorin själv, så regler ändrar den aldrig.";
  else if (reason.rule) explanation = `Regeln ${text(reason.rule)} gav kategorin. ${reason.rule.own ? "Det är en av dina egna regler." : "Det är en mallregel."}`;
  else if (reason.source === "none") explanation = reason.alsoMatched.length > 0 ? "Ingen kategori är satt än. Dessa regler träffar:" : "Ingen kategori är vald, och ingen regel träffar den här transaktionen.";
  else explanation = "Kategorin kom från en regel som sedan har ändrats eller tagits bort. Transaktionen behåller den.";

  // Listan har en egen inledning, utom när förklaringen redan slutar med att ange den (ingen kategori än).
  const intro = reason.source === "none" ? null : reason.rule ? "Andra regler som också träffar, i den ordning de vinner:" : "Regler som träffar den här transaktionen, i den ordning de vinner:";

  return (
    <>
      <Button variant="quiet" onClick={() => { setOpen(true); }}>
        Varför den här kategorin?
      </Button>
      <Sheet open={open} title="Varför den här kategorin?" onClose={() => { setOpen(false); }}>
        <div className="ui-stack">
          <p className="ui-body">{explanation}</p>
          {reason.alsoMatched.length > 0 && (
            <>
              {intro !== null && <p className="ui-body">{intro}</p>}
              <List label="Regler som också träffar">
                {reason.alsoMatched.map((r) => (
                  <ListRow key={r.id} label={text(r)} detail={r.own ? "Egen regel" : "Mallregel"} />
                ))}
              </List>
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
