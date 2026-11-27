// Ark nerifrån och dialog (KK-65-A). Båda bygger på webbläsarens <dialog> som modal: fokus stannar i
// den, Esc stänger och resten av sidan går inte att nå. Ark används för val och formulär, dialog för en
// fråga som måste besvaras, t.ex. innan något tas bort. Innehållet ritas bara när det är öppet.
import { X } from "lucide-react";
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";
import { pushOverlay } from "../router.tsx";
import { IconButton } from "./Button.tsx";

function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    // Esc: vyn bestämmer själv när den stänger, via open.
    const onCancel = (event: Event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener("cancel", onCancel);
    // Bakåtknappen stänger arket, inte vyn bakom (KK-62-E).
    const release = pushOverlay(() => {
      close.current();
    });
    return () => {
      release();
      dialog.removeEventListener("cancel", onCancel);
      if (typeof dialog.close === "function") dialog.close();
    };
  }, [open]);

  /** Ett tryck på bakgrunden träffar själva <dialog>, inte innehållet. */
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  return { ref, onClick };
}

export function Sheet(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const { ref, onClick } = useModal(props.open, props.onClose);
  const titleId = useId();
  if (!props.open) return null;
  return (
    <dialog ref={ref} className="ui-sheet" aria-labelledby={titleId} onClick={onClick}>
      <div className="ui-sheet-body">
        <span className="ui-sheet-handle" aria-hidden="true" />
        <header className="ui-sheet-header">
          <h2 id={titleId} className="ui-heading">
            {props.title}
          </h2>
          <IconButton label="Stäng" icon={X} onClick={props.onClose} />
        </header>
        {props.children}
      </div>
    </dialog>
  );
}

export function Dialog(props: { open: boolean; title: string; onClose: () => void; actions: ReactNode; children: ReactNode }) {
  const { ref, onClick } = useModal(props.open, props.onClose);
  const titleId = useId();
  const textId = useId();
  if (!props.open) return null;
  return (
    <dialog ref={ref} className="ui-dialog" aria-labelledby={titleId} aria-describedby={textId} onClick={onClick}>
      <div className="ui-dialog-body">
        <h2 id={titleId} className="ui-heading">
          {props.title}
        </h2>
        <p id={textId} className="ui-body">
          {props.children}
        </p>
        <div className="ui-dialog-actions">{props.actions}</div>
      </div>
    </dialog>
  );
}
