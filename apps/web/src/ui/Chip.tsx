// Chip eller etikett (KK-65-A): en kort text med ton bredvid något annat, t.ex. "Preliminär" på en
// transaktion eller "Buffert" på ett konto. Tonerna har sin text mot sin mjuka bakgrund med 4,5:1.
import type { ReactNode } from "react";

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

export function Chip(props: { tone?: Tone; children: ReactNode }) {
  return <span className={`ui-chip ui-chip-${props.tone ?? "neutral"}`}>{props.children}</span>;
}
