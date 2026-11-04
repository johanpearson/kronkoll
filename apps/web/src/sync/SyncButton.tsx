// Synka nu (KK-7-C): startar en manuell synk, visar en ikon som snurrar så länge den pågår och säger till
// när den är klar, så att vyn kan hämta om sina siffror. Servern säger när synkens körningar är klara
// (GET /api/sync?since=…). Kategorisering och överföringar görs strax efter körningarna, så vyn väntar
// en omgång till innan den hämtar om.
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { field, getJson, postJson } from "../api.ts";
import { useToast } from "../toast.tsx";

/** Hur ofta knappen frågar om synken är klar. */
export const POLL_MS = 2000;
/** Så länge knappen väntar innan den hämtar om ändå: en stor synk kan ta tid. */
export const MAX_WAIT_MS = 120_000;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function SyncButton(props: { onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const toast = useToast();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  /** Frågar tills synken är klar eller det har gått för lång tid. Sant om den blev klar. */
  const waitUntilDone = async (since: string) => {
    for (let waited = 0; waited < MAX_WAIT_MS && mounted.current; waited += POLL_MS) {
      await wait(POLL_MS);
      const { status, body } = await getJson(`/api/sync?since=${encodeURIComponent(since)}`);
      if (status === 200 && field(body, "done") === true) {
        await wait(POLL_MS);
        return true;
      }
    }
    return false;
  };

  const start = async () => {
    setRunning(true);
    const { status, body } = await postJson("/api/sync", {});
    const since = field(body, "started_at");
    if (status === 202 && typeof since === "string") {
      const done = await waitUntilDone(since);
      if (!mounted.current) return;
      if (done) toast.done("Synken är klar.");
      else toast.problem("Synken tar längre tid än vanligt. Ladda om sidan om en stund för att se allt.");
      props.onDone();
    } else if (status === 429) {
      const minutes = Math.max(1, Math.ceil((Number(field(body, "retry_after_s")) || 60) / 60));
      toast.problem(`Du kan synka igen om ${String(minutes)} min.`);
    } else {
      toast.problem("Det gick inte att starta synken. Försök igen om en stund.");
    }
    setRunning(false);
  };

  return (
    <button type="button" className="sync-button" disabled={running} aria-busy={running} onClick={() => void start()}>
      <RefreshCw aria-hidden="true" size={18} strokeWidth={2} className={running ? "spin" : undefined} />
      {running ? "Synkar…" : "Synka nu"}
    </button>
  );
}
