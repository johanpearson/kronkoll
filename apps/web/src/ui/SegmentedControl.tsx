// Segmentkontroll (KK-65-A): ett val bland två till fyra alternativ, t.ex. Månad, År eller Allt. Byggd
// som en grupp radioknappar: tab når det valda alternativet och piltangenterna byter val.
import type { KeyboardEvent } from "react";

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function SegmentedControl<T extends string>(props: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { options } = props;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const current = options.findIndex((o) => o.value === props.value);
    const next = (current + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    props.onChange(option.value);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };
  return (
    <div className="ui-segmented" role="radiogroup" aria-label={props.label}>
      {options.map((option) => {
        const checked = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              props.onChange(option.value);
            }}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
