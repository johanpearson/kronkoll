// Geometrin i diagrammen: från belopp till koordinater i SVG. Ren matematik, så att den testas utan DOM.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Staplar nerifrån och upp. Max är det största värdet om inget annat anges, t.ex. budgeten. */
export function barRects(values: readonly number[], box: { width: number; height: number; gap: number; max?: number | undefined }): Rect[] {
  if (values.length === 0) return [];
  const max = box.max ?? Math.max(0, ...values);
  const width = (box.width - box.gap * (values.length - 1)) / values.length;
  return values.map((value, i) => {
    const share = max > 0 ? Math.min(Math.max(value, 0) / max, 1) : 0;
    const height = round(share * box.height);
    return { x: round(i * (width + box.gap)), y: round(box.height - height), width: round(width), height };
  });
}

/** Hur mycket av ringens omkrets som ska vara tom: hela vid noll, ingen när målet är nått eller passerat. */
export function ringOffset(value: number, total: number, circumference: number): number {
  const share = total > 0 ? Math.min(Math.max(value / total, 0), 1) : 0;
  return round(circumference * (1 - share));
}

/** Punkterna till en <polyline>: jämnt över bredden, och y vänt så att större värden står högre. */
export function linePoints(values: readonly number[], box: { width: number; height: number }): string {
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const step = values.length > 1 ? box.width / (values.length - 1) : 0;
  return values
    .map((value, i) => {
      const x = values.length > 1 ? i * step : box.width / 2;
      const y = span > 0 ? box.height - ((value - min) / span) * box.height : box.height / 2;
      return `${String(round(x))},${String(round(y))}`;
    })
    .join(" ");
}
