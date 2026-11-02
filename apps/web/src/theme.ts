// Ljust, mörkt eller som systemet (KK-26-A). Valet sparas bara på den här enheten, som en bekvämlighet:
// fungerar inte lagringen följer appen systemet. Utloggningen tömmer lagringen, och då återgår valet.
export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "kronkoll.theme";

const isChosen = (value: unknown): value is "light" | "dark" => value === "light" || value === "dark";

export function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return isChosen(value) ? value : "system";
  } catch {
    return "system";
  }
}

/** Sätter temat på sidan direkt och sparar valet om det går. */
export function setTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Valet gäller ändå tills sidan laddas om.
  }
}

/** Körs vid start, innan appen ritas, så att sparat val gäller från första bilden. */
export function applyStoredTheme(): void {
  const theme = storedTheme();
  if (theme !== "system") document.documentElement.dataset.theme = theme;
}
