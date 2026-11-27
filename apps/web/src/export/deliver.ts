// Ger en fil till användaren (KK-43-C): på en telefon öppnas delningsmenyn (Web Share), annars och om
// delningen inte fungerar laddas filen ned. Att användaren stänger delningsmenyn är inget fel.

export type Delivery = "shared" | "downloaded" | "cancelled";

type Sharer = Pick<Navigator, "canShare" | "share">;

function download(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // Nedladdningen hinner starta innan adressen släpps.
  setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
}

export async function deliverFile(file: File, title: string, nav: Partial<Sharer> = navigator): Promise<Delivery> {
  if (typeof nav.canShare === "function" && typeof nav.share === "function" && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      // Delningen gick inte att göra: ladda ned i stället.
    }
  }
  download(file);
  return "downloaded";
}
