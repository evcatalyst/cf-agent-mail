const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export type ParsedAddress = { email: string; name?: string };

export function stripCrlf(value: string): string {
  let cleaned = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    cleaned += code < 32 || code === 127 ? " " : char;
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

export function parseAddress(raw: string): ParsedAddress | null {
  const trimmed = stripCrlf(raw);
  if (!trimmed) return null;
  const angled = trimmed.match(/^(.*?)<([^<>]+)>$/);
  if (angled) {
    const email = angled[2].trim().toLowerCase();
    const name = angled[1].trim().replace(/^"|"$/g, "").trim();
    if (!EMAIL.test(email)) return null;
    return name ? { email, name } : { email };
  }
  const email = trimmed.toLowerCase();
  if (!EMAIL.test(email)) return null;
  return { email };
}

export function splitLocal(
  email: string,
): { slug: string; tag?: string; domain: string } | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  const plus = local.indexOf("+");
  const slug = plus === -1 ? local : local.slice(0, plus);
  const tag = plus === -1 ? undefined : local.slice(plus + 1);
  if (!SLUG.test(slug) || !domain) return null;
  return tag ? { slug, tag, domain } : { slug, domain };
}

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

export function normalizeSubject(subject: string): string {
  let value = stripCrlf(subject).toLowerCase();
  let previous = "";
  while (value !== previous) {
    previous = value;
    value = value.replace(/^(re|fwd|fw)\s*:\s*/, "").trim();
  }
  return value.replace(/\s+/g, " ");
}

export function previewText(text: string, length = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

export function parentDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2) return hostname.toLowerCase();
  return parts.slice(-2).join(".");
}

export function sameOrgHost(host: string, mailDomain: string): boolean {
  const left = host.toLowerCase().replace(/\.$/, "");
  const org = parentDomain(mailDomain);
  return (
    left === org ||
    left.endsWith(`.${org}`) ||
    left === mailDomain.toLowerCase()
  );
}

export async function signThreadTag(
  threadId: string,
  key: string,
): Promise<string> {
  const { hmacHex } = await import("./crypto");
  const mac = await hmacHex(key, threadId);
  return `t.${threadId}.${mac.slice(0, 8)}`;
}

export async function verifyThreadTag(
  tag: string,
  key: string,
): Promise<string | null> {
  const match = /^t\.(thd_[a-f0-9]+)\.([a-f0-9]{8})$/.exec(tag);
  if (!match) return null;
  const { hmacHex, timingSafeEqual } = await import("./crypto");
  const mac = await hmacHex(key, match[1]);
  if (!timingSafeEqual(mac.slice(0, 8), match[2])) return null;
  return match[1];
}

export function ftsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (!words || words.length === 0) return null;
  return words.map((word) => `"${word}"*`).join(" AND ");
}

export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
