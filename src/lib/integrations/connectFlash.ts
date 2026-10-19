// One-shot "who just connected" note, carried from the OAuth callback to the
// success toast. The provider sign-in can silently reuse whatever profile the
// browser is already signed in to (Facebook says "Continue as …"), so the
// toast names the account and the signed-in identity, which makes a connect
// under the wrong profile obvious at once. A short-lived cookie scoped to
// /dashboard carries it, keeping names out of the URL and browser history.
// Shared by the server (callback) and the client (toast), so no Node-only APIs.

export const CONNECT_FLASH_COOKIE = "connect_flash";
export const CONNECT_FLASH_MAX_AGE = 120; // seconds

// `note`: what a renewal of a shared sign-in did ("Renewed for 4 sources; 1
// ad account still needs access").
export type ConnectFlash = { account: string | null; identity: string | null; note?: string | null };

const clip = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim().slice(0, 120) : null);

export function encodeConnectFlash(flash: ConnectFlash): string {
  const note = clip(flash.note);
  const json = JSON.stringify({ account: clip(flash.account), identity: clip(flash.identity), ...(note ? { note } : {}) });
  const bin = Array.from(new TextEncoder().encode(json), (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeConnectFlash(value: string | null | undefined): ConnectFlash | null {
  if (!value) return null;
  try {
    const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    const note = clip(parsed?.note);
    const flash: ConnectFlash = { account: clip(parsed?.account), identity: clip(parsed?.identity), ...(note ? { note } : {}) };
    return flash.account || flash.identity || flash.note ? flash : null;
  } catch {
    return null;
  }
}

// The toast's second line: which account, as whom, and what a renewal did.
export function describeConnectFlash(flash: ConnectFlash | null): string | undefined {
  if (!flash) return undefined;
  const parts = [flash.account, flash.identity ? `signed in as ${flash.identity}` : null, flash.note].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}
