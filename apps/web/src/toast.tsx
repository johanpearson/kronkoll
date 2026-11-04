// Korta notiser ovanför menyn (KK-26-C). En bekräftelse försvinner av sig själv efter TOAST_MS, så att
// vyn inte fylls av gamla meddelanden. Ett fel ligger kvar tills användaren stänger det. En ny notis
// ersätter den förra.
import { X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export const TOAST_MS = 4000;

interface Toaster {
  /** Något gick bra, t.ex. "Synken är klar." Försvinner efter en stund. */
  done(message: string): void;
  /** Något gick inte, eller användaren behöver veta något innan hen går vidare. Ligger kvar. */
  problem(message: string): void;
}

interface Toast {
  readonly message: string;
  readonly kind: "done" | "problem";
}

const ToastContext = createContext<Toaster | null>(null);

export function useToast(): Toaster {
  const toaster = useContext(ToastContext);
  if (!toaster) throw new Error("useToast kräver ToastProvider");
  return toaster;
}

export function ToastProvider(props: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const toaster = useMemo<Toaster>(
    () => ({
      done: (message) => { setToast({ message, kind: "done" }); },
      problem: (message) => { setToast({ message, kind: "problem" }); },
    }),
    [],
  );

  useEffect(() => {
    if (toast?.kind !== "done") return;
    const timer = setTimeout(() => { setToast(null); }, TOAST_MS);
    return () => { clearTimeout(timer); };
  }, [toast]);

  return (
    <ToastContext.Provider value={toaster}>
      {props.children}
      <div className="toasts">
        {toast?.kind === "done" && (
          <p role="status" className="toast">
            {toast.message}
          </p>
        )}
        {toast?.kind === "problem" && (
          <div role="alert" className="toast problem">
            <p>{toast.message}</p>
            <button type="button" aria-label="Stäng" onClick={() => { setToast(null); }}>
              <X aria-hidden="true" size={18} />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
