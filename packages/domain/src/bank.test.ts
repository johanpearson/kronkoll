import { describe, expect, it } from "vitest";
import { ProviderError } from "./bank.ts";

describe("fel från banken (KK-13)", () => {
  it("bär bara en felkod, aldrig bankens text", () => {
    const error = new ProviderError("RATE_LIMITED");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "ProviderError", code: "RATE_LIMITED" });
    expect(error.message).toBe("Banken svarade med fel: RATE_LIMITED");
  });
});
