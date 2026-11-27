// @vitest-environment jsdom
// Chip eller etikett (KK-65-A): kort text med ton, t.ex. "Preliminär" eller "Buffert".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Chip } from "./Chip.tsx";

afterEach(cleanup);

describe("Chip (KK-65-A)", () => {
  it("är neutral om inget annat sägs", () => {
    render(<Chip>Buffert</Chip>);
    expect(screen.getByText("Buffert").className).toBe("ui-chip ui-chip-neutral");
  });

  it.each(["primary", "success", "warning", "danger"] as const)("har tonen %s", (tone) => {
    render(<Chip tone={tone}>Preliminär</Chip>);
    expect(screen.getByText("Preliminär").className).toBe(`ui-chip ui-chip-${tone}`);
  });
});
