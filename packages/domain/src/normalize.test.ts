import { describe, expect, it } from "vitest";
import { learnPattern, matchesWordPrefix, normalizeCounterparty } from "./normalize.ts";

describe("normalisering av motpart (F-learn)", () => {
  it.each([
    ["ort på slutet tas bort", "ICA NARA SOFO STHLM", "ICA NARA SOFO"],
    ["kortprefix K* tas bort", "K*ICA KVANTUM", "ICA KVANTUM"],
    ["Square-prefix och butiksnummer", "SQ *KAFFEBAREN 123", "KAFFEBAREN"],
    ["PayPal-prefix", "PAYPAL *SPOTIFY", "SPOTIFY"],
    ["iZettle-prefix", "IZ *FIKA", "FIKA"],
    ["nummer och ort", "SL 12345 STOCKHOLM", "SL"],
    ["flera orter och landskod", "PRESSBYRAN 4711 GOTEBORG SE", "PRESSBYRAN"],
    ["gemener, extra blanksteg och å/ä/ö", "  ica  nära  sofo ", "ICA NÄRA SOFO"],
    ["siffror inne i ett namn behålls", "7-ELEVEN 1234", "7-ELEVEN"],
    ["punkter och domäner behålls", "NETFLIX.COM", "NETFLIX.COM"],
    ["en ort ensam tas inte bort", "STOCKHOLM", "STOCKHOLM"],
    ["tom text blir tom", "   ", ""],
    ["Klarna-prefix", "KLARNA *ZALANDO", "ZALANDO"],
    ["SumUp-prefix", "SUMUP *LOPPIS", "LOPPIS"],
    ["Zettle med understreck", "ZETTLE_*GLASSKIOSKEN", "GLASSKIOSKEN"],
  ])("%s: %j → %j", (_, raw, normalized) => {
    expect(normalizeCounterparty(raw)).toBe(normalized);
  });

  it("är idempotent: att normalisera två gånger ger samma resultat", () => {
    for (const raw of ["K*ICA KVANTUM 12 STHLM", "SQ *KAFFEBAREN 123", "  ica  nära  sofo "]) {
      const once = normalizeCounterparty(raw);
      expect(normalizeCounterparty(once)).toBe(once);
    }
  });
});

describe("mönster att lära sig", () => {
  it("är hela den normaliserade motparten, inte bara första ordet", () => {
    expect(learnPattern("ICA NARA SOFO")).toBe("ICA NARA SOFO");
    expect(learnPattern("SWISH ANNA")).toBe("SWISH ANNA");
    expect(learnPattern("SL")).toBe("SL");
  });

  it("ger inget mönster för tom motpart", () => {
    expect(learnPattern("")).toBeNull();
    expect(learnPattern("   ")).toBeNull();
  });

  it("slår inte ihop motparter som bara delar första ord", () => {
    const pattern = learnPattern("SWISH ANNA");
    expect(pattern).not.toBeNull();
    expect(matchesWordPrefix(pattern ?? "", "SWISH ANNA")).toBe(true);
    expect(matchesWordPrefix(pattern ?? "", "SWISH KALLE")).toBe(false);
  });
});

describe("matchning på ordprefix", () => {
  it.each([
    ["ICA", "ICA KVANTUM", true],
    ["ICA", "ICA", true],
    ["ICA", "ICAROS", false],
    ["ICA NARA", "ICA NARA SOFO", true],
    ["SL", "SLÖJDBODEN", false],
    ["", "ICA", false],
  ])("%j mot %j: %s", (pattern, value, expected) => {
    expect(matchesWordPrefix(pattern, value)).toBe(expected);
  });
});
