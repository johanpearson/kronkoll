// Synkstatus i sidhuvudet (KK-64-A, KK-7-C). En ikon snurrar medan synken pågår, visar en bock en kort stund när
// den är klar och en varning om den misslyckades. Ett tryck visar senaste synk, eventuellt fel och knappen Synka
// nu i ett litet ark. Synken visar ingen notis: skärmläsare får läget i en tyst region i stället.
// Servern säger när synkens körningar är klara (GET /api/sync?since=…). Kategorisering och överföringar görs
// strax efter körningarna, så vyn väntar en omgång till innan den hämtar om.
import { Check, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { field, getJson, postJson } from "../api.ts";
import { Button } from "../ui/Button.tsx";
import { Sheet } from "../ui/Modal.tsx";

/** Hur ofta ikonen frågar om synken är klar. */
export const POLL_MS = 2000;
/** Så länge den väntar innan vyn hämtar om ändå: en stor synk kan ta tid. */
export const MAX_WAIT_MS = 120_000;
/** Så länge bocken syns efter en klar synk. */
export const DONE_MS = 3000;

type State = { readonly kind: "idle" } | { readonly kind: "running" } | { readonly kind: "done" } | { readonly kind: "failed"; readonly message: string };

const LABEL: Record<State["kind"], string> = { idle: "Synkstatus", running: "Synkar…", done: "Synken är klar", failed: "Synken misslyckades" };
const ICON = { idle: RefreshCw, running: RefreshCw, done: Check, failed: TriangleAlert };

/** Den som ber om en synk utan att trycka på ikonen, t.ex. dra för att synka (KK-63-D). */
const requests = new Set<() => void>();

export function requestSync(): void {
  for (const listener of requests) listener();
}

export function onSyncRequest(listener: () => void): () => void {
  requests.add(listener);
  return () => {
    requests.delete(listener);
  };
}

const syncTime = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function SyncStatus(props: { lastSyncAt?: string | null; onDone: () => void }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // Bocken visas en kort stund och byts sedan mot den vanliga ikonen.
  useEffect(() => {
    if (state.kind !== "done") return;
    const timer = setTimeout(() => { setState({ kind: "idle" }); }, DONE_MS);
    return () => { clearTimeout(timer); };
  }, [state]);

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
    setOpen(false);
    setState({ kind: "running" });
    const { status, body } = await postJson("/api/sync", {});
    const since = field(body, "started_at");
    if (status === 202 && typeof since === "string") {
      const done = await waitUntilDone(since);
      if (!mounted.current) return;
      setState(done ? { kind: "done" } : { kind: "failed", message: "Synken tar längre tid än vanligt. Ladda om sidan om en stund för att se allt." });
      props.onDone();
    } else if (status === 429) {
      const minutes = Math.max(1, Math.ceil((Number(field(body, "retry_after_s")) || 60) / 60));
      setState({ kind: "failed", message: `Du kan synka igen om ${String(minutes)} min.` });
    } else {
      setState({ kind: "failed", message: "Det gick inte att starta synken. Försök igen om en stund." });
    }
  };

  // En begäran utifrån startar synken, men inte en till medan en pågår.
  const latest = useRef({ running: false, start });
  latest.current = { running: state.kind === "running", start };
  useEffect(
    () =>
      onSyncRequest(() => {
        if (!latest.current.running) void latest.current.start();
      }),
    [],
  );

  const Icon = ICON[state.kind];
  const running = state.kind === "running";
  return (
    <>
      <button
        type="button"
        className={`ui-icon-button ui-sync ui-sync-${state.kind}`}
        aria-label={LABEL[state.kind]}
        title={LABEL[state.kind]}
        aria-busy={running}
        onClick={() => { setOpen(true); }}
      >
        <Icon aria-hidden="true" size={20} strokeWidth={2} className={running ? "spin" : undefined} />
      </button>
      <span className="ui-visually-hidden" aria-live="polite">
        {running ? "Synkar…" : state.kind === "done" ? "Synken är klar." : ""}
      </span>
      <Sheet open={open} title="Synk" onClose={() => { setOpen(false); }}>
        {props.lastSyncAt !== undefined && (
          <p className="ui-body">{props.lastSyncAt === null ? "Inte synkad än" : `Senast synkad ${syncTime.format(new Date(props.lastSyncAt))}`}</p>
        )}
        {running && <p className="ui-body">Synken pågår.</p>}
        {state.kind === "failed" && <p className="ui-field-error">{state.message}</p>}
        <Button variant="primary" block disabled={running} onClick={() => void start()}>
          Synka nu
        </Button>
      </Sheet>
    </>
  );
}
