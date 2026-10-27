const ALPHABET = "0123456789abcdef";

export function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += ALPHABET[byte >> 4];
    hex += ALPHABET[byte & 0x0f];
  }
  return `${prefix}_${hex}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Widen wrangler literal var types so comparisons against other values typecheck. */
export function asString(value: string): string {
  return value;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function encodePage(offset: number): string {
  return btoa(String(offset)).replace(/=+$/g, "");
}

export function decodePage(token: string | undefined): number {
  if (!token) return 0;
  try {
    const padded = token + "=".repeat((4 - (token.length % 4)) % 4);
    const value = Number(atob(padded));
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value);
  } catch {
    return 0;
  }
}

export function clampLimit(value: unknown, fallback = 10, max = 100): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}
