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
    // Skandias kortköp: "BUTIK, ORT", ibland med butiksnumret ihopskrivet med namnet.
    ["ort efter kommatecken tas bort", "VASTTRAFIK APP, GOTEBORG", "VASTTRAFIK APP"],
    ["butiksnummer ihop med namnet", "WILLYS42ODENPLAN, STOCKHOLM", "WILLYS ODENPLAN"],
    ["bara sista kommatecknet räknas", "PIZZERIA ROMA H, H R", "PIZZERIA ROMA H"],
    ["ett kommatecken först lämnar namnet", ", SOLNA", "SOLNA"],
    // Näthandel: "BUTIK*ORDERNUMMER, WEBBADRESS". Ordernumret är olika för varje köp.
    ["ordernummer efter stjärna tas bort", "AmazonMktplc*AB1CD234E5, www.amazon.se", "AMAZONMKTPLC"],
    ["samma butik, annat ordernummer", "AmazonMktplc*ZZ9XY876W1, www.amazon.se", "AMAZONMKTPLC"],
    ["stjärna med blanksteg", "WEBBSHOP * 12AB34, WWW.WEBBSHOP.SE", "WEBBSHOP"],
    ["kortprefix före stjärna gäller fortfarande", "K*ICA NARA*7788", "ICA NARA"],
    ["en kod med siffror på flera ställen tas bort även utan stjärna", "WEBBSHOP AB12CD34, WWW.WEBBSHOP.SE", "WEBBSHOP"],
    ["en kod mitt i texten", "BUTIKEN X9Y8Z7 STORGATAN", "BUTIKEN STORGATAN"],
  ])("%s: %j → %j", (_, raw, normalized) => {
    expect(normalizeCounterparty(raw)).toBe(normalized);
  });

  it.each([
    "SE", "SWE", "SVERIGE", "STHLM", "STOCKHOLM", "GBG", "GOTEBORG", "GÖTEBORG", "MALMO", "MALMÖ",
    "UPPSALA", "LINKOPING", "LINKÖPING", "OREBRO", "ÖREBRO", "VASTERAS", "VÄSTERÅS",
    "HELSINGBORG", "NORRKOPING", "NORRKÖPING", "JONKOPING", "JÖNKÖPING", "UMEA", "UMEÅ", "LUND",
    "SOLNA", "SUNDBYBERG", "NACKA", "HUDDINGE",
  ])("orten %s sist tas bort", (place) => {
    expect(normalizeCounterparty(`BAGERIET ${place}`)).toBe("BAGERIET");
  });

  it("andra ord sist behålls", () => {
    expect(normalizeCounterparty("BAGERIET HORNSTULL")).toBe("BAGERIET HORNSTULL");
  });

  it("är idempotent: att normalisera två gånger ger samma resultat", () => {
    for (const raw of ["K*ICA KVANTUM 12 STHLM", "SQ *KAFFEBAREN 123", "  ica  nära  sofo ", "WILLYS42ODENPLAN, STOCKHOLM"]) {
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
