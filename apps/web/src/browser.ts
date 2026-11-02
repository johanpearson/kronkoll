// Det appen gör med webbläsarens adress utöver routern. Samlat här så att testerna kan ersätta det.
export const browser = {
  /** Lämnar appen för en annan sida, till exempel bankens inloggning. */
  assign(url: string): void {
    window.location.assign(url);
  },
};
