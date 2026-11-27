// Diskreta notiser upptill (KK-64). En bekräftelse glider in under sidans överkant, försvinner efter
// TOAST_MS och kan sveps bort. Den täcker aldrig flikmenyn eller knappar längst ned (KK-64-B). En åtgärd
// som går att ångra har knappen Ångra (KK-64-F). Ett fel som inte hör till något ställe i vyn ligger kvar
// tills det stängs (KK-64-D). En ny notis ersätter den förra. Skärmläsare läser upp dem (KK-64-E).
import { X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";

export const TOAST_MS = 3000;

/** Så långt ett finger ska dra notisen åt sidan eller uppåt för att den ska försvinna. */
const SWIPE_PX = 48;

interface Toaster {
  /** Något gick bra, t.ex. "Regeln är sparad." Försvinner efter en stund. Med undo visas knappen Ångra. */
  done(message: string, options?: { undo?: () => void }): void;
  /** Något gick inte, och det hör inte till något ställe i vyn. Ligger kvar tills det stängs. */
  problem(message: string): void;
}

interface Toast {
  readonly message: string;
  readonly kind: "done" | "problem";
  readonly undo?: () => void;
}

const ToastContext = createContext<Toaster | null>(null);

export function useToast(): Toaster {
  const toaster = useContext(ToastContext);
  if (!toaster) throw new Error("useToast kräver ToastProvider");
  return toaster;
}

export function ToastProvider(props: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const toaster = useMemo<Toaster>(
    () => ({
      done: (message, options) => {
        setToast({ message, kind: "done", ...(options?.undo ? { undo: options.undo } : {}) });
      },
      problem: (message) => {
        setToast({ message, kind: "problem" });
      },
    }),
    [],
  );

  useEffect(() => {
    if (toast?.kind !== "done") return;
    // Med Ångra får man dubbelt så lång tid på sig att hinna trycka.
    const timer = setTimeout(() => { setToast(null); }, toast.undo ? TOAST_MS * 2 : TOAST_MS);
    return () => { clearTimeout(timer); };
  }, [toast]);

  const close = () => { setToast(null); };
  const swipe = {
    onPointerDown: (event: PointerEvent) => {
      start.current = { x: event.clientX, y: event.clientY };
    },
    onPointerUp: (event: PointerEvent) => {
      const from = start.current;
      start.current = null;
      if (!from) return;
      if (Math.abs(event.clientX - from.x) > SWIPE_PX || from.y - event.clientY > SWIPE_PX) close();
    },
  };

  return (
    <ToastContext.Provider value={toaster}>
      {props.children}
      <div className="ui-toasts">
        {toast?.kind === "done" && (
          <div role="status" className="ui-toast" {...swipe}>
            <p>{toast.message}</p>
            {toast.undo && (
              <button
                type="button"
                className="ui-toast-action"
                onClick={() => {
                  toast.undo?.();
                  close();
                }}
              >
                Ångra
              </button>
            )}
          </div>
        )}
        {toast?.kind === "problem" && (
          <div role="alert" className="ui-toast ui-toast-problem" {...swipe}>
            <p>{toast.message}</p>
            <button type="button" className="ui-toast-close" aria-label="Stäng" onClick={close}>
              <X aria-hidden="true" size={18} />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
