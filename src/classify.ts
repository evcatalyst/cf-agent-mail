import { parentDomain, sameOrgHost, stripCrlf } from "./address";

const ZERO_WIDTH = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g;
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;

const INSTRUCTION = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+instructions/i,
  /disregard\s+(your|the|all)\s+(rules|instructions|policies)/i,
  /forward\s+all\s+(the\s+)?(mail|email|messages)/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /system\s+prompt/i,
  /do\s+not\s+tell\s+the\s+(user|owner|human)/i,
  /owner\s+approved/i,
  /approval\s+granted/i,
  /i\s+approve\s+sending/i,
];

const OTP_PHISH =
  /(verification code|one[- ]time (password|code)|sign[- ]in code|login code)/i;

const HIGH_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-msdownload",
  "application/javascript",
  "text/javascript",
  "text/html",
  "image/svg+xml",
  "application/x-sh",
  "application/x-executable",
  "application/octet-stream",
]);

const HIGH_EXT = [
  ".exe",
  ".js",
  ".zip",
  ".html",
  ".htm",
  ".svg",
  ".sh",
  ".bat",
  ".cmd",
  ".msi",
  ".jar",
  ".scr",
];

export type AuthFacts = {
  status: "pass" | "fail" | "unknown";
  spf?: string;
  dkim?: string;
  dmarc?: string;
};

export type Classification = {
  score: number;
  reasons: string[];
  quarantine: boolean;
  auto: boolean;
  text: string;
  hiddenRemoved: boolean;
};

export function parseAuth(
  headers: { key: string; value: string }[],
): AuthFacts {
  const auth =
    headers.find(
      (header) => header.key.toLowerCase() === "authentication-results",
    )?.value ?? "";
  const spfHeader =
    headers.find((header) => header.key.toLowerCase() === "received-spf")
      ?.value ?? "";
  const grab = (name: string, source: string) => {
    const match = new RegExp(`${name}\\s*=\\s*([a-z]+)`, "i").exec(source);
    return match?.[1]?.toLowerCase();
  };
  const spf =
    grab("spf", auth) ??
    grab("spf", spfHeader) ??
    (spfHeader.toLowerCase().startsWith("pass") ? "pass" : undefined);
  const dkim = grab("dkim", auth);
  const dmarc = grab("dmarc", auth);
  const values = [spf, dkim, dmarc].filter(Boolean);
  if (values.length === 0) return { status: "unknown" };
  const status = values.some(
    (value) => value === "fail" || value === "softfail",
  )
    ? "fail"
    : "pass";
  return { status, spf, dkim, dmarc };
}

export function htmlToText(html: string): {
  text: string;
  hiddenRemoved: boolean;
  linkMismatch: boolean;
} {
  let hiddenRemoved = false;
  let source = html;
  source = source.replace(/<script[\s\S]*?<\/script>/gi, " ");
  source = source.replace(/<style[\s\S]*?<\/style>/gi, " ");
  source = source.replace(
    /<([a-z0-9]+)[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|color\s*:\s*(?:#fff|#ffffff|white)[^"']*background(?:-color)?\s*:\s*(?:#fff|#ffffff|white))[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi,
    (_all, _tag, inner: string) => {
      if (stripTags(inner).trim()) hiddenRemoved = true;
      return " ";
    },
  );
  const links: { href: string; text: string }[] = [];
  source = source.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_all, href: string, inner: string) => {
      const text = stripTags(inner).trim();
      links.push({ href, text });
      return ` ${text} (${href}) `;
    },
  );
  let text = decodeEntities(stripTags(source));
  const zero = text.match(ZERO_WIDTH);
  const bidi = text.match(BIDI);
  if (zero?.length) hiddenRemoved = true;
  text = text.replace(ZERO_WIDTH, "").replace(BIDI, "");
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const linkMismatch = links.some((link) =>
    hostsDisagree(link.href, link.text),
  );
  return {
    text,
    hiddenRemoved: hiddenRemoved || Boolean(bidi?.length),
    linkMismatch,
  };
}

export function sanitizeInbound(input: {
  text?: string;
  html?: string;
  subject: string;
}): {
  text: string;
  subject: string;
  headerInjection: boolean;
  hiddenRemoved: boolean;
  linkMismatch: boolean;
  bidi: boolean;
} {
  const headerInjection = /[\r\n]/.test(input.subject);
  const subject = stripCrlf(input.subject);
  const html = input.html
    ? htmlToText(input.html)
    : { text: "", hiddenRemoved: false, linkMismatch: false };
  let text = input.text ?? "";
  const bidi = hasBidi(text) || hasBidi(html.text);
  if (hasZeroWidth(text)) html.hiddenRemoved = true;
  text = text.replace(ZERO_WIDTH, "").replace(BIDI, "").trim();
  const combined = [text, html.text].filter(Boolean).join("\n\n");
  const markdownMismatch = markdownLinks(combined).some((link) =>
    hostsDisagree(link.href, link.text),
  );
  return {
    text: combined,
    subject,
    headerInjection,
    hiddenRemoved: html.hiddenRemoved,
    linkMismatch: html.linkMismatch || markdownMismatch,
    bidi,
  };
}

export function classifyInbound(input: {
  text: string;
  subject: string;
  headerInjection: boolean;
  hiddenRemoved: boolean;
  linkMismatch: boolean;
  bidi: boolean;
  auth: AuthFacts;
  fromName?: string;
  fromAddr: string;
  knownNames: string[];
  knownAddresses: string[];
  riskyAttachment: boolean;
  autoHeader: boolean;
  referencesCount: number;
  senderPolicy: string;
  senderKnown: boolean;
  senderBlocked: boolean;
  overSenderBudget: boolean;
  mailDomain: string;
}): Classification {
  const reasons: string[] = [];
  let score = 0;
  const blob = `${input.subject}\n${input.text}`;
  if (INSTRUCTION.some((pattern) => pattern.test(blob))) {
    reasons.push("instruction_like");
    score += 80;
  }
  if (input.hiddenRemoved) {
    reasons.push("hidden_text");
    score += 40;
  }
  if (input.bidi) {
    reasons.push("bidi");
    score += 40;
  }
  if (input.linkMismatch) {
    reasons.push("link_mismatch");
    score += 70;
  }
  if (input.headerInjection) {
    reasons.push("header_injection");
    score += 60;
  }
  if (input.riskyAttachment) {
    reasons.push("risky_attachment");
    score += 50;
  }
  if (input.auth.status === "fail") {
    reasons.push("auth_fail");
    score += 50;
  }
  const name = (input.fromName ?? "").trim().toLowerCase();
  const claimsKnown =
    name.length > 0 &&
    input.knownNames.some((known) => known.toLowerCase() === name);
  const addressKnown = input.knownAddresses.some(
    (address) => address.toLowerCase() === input.fromAddr.toLowerCase(),
  );
  if (claimsKnown && !addressKnown) {
    reasons.push("impersonation");
    score += 80;
  }
  if (input.auth.status !== "pass" && claimsKnown) {
    reasons.push("auth_claim");
    score += 30;
  }
  if (OTP_PHISH.test(blob) && hasForeignLink(blob, input.mailDomain)) {
    reasons.push("otp_phish");
    score += 70;
  }
  if (/owner\s+approved|approval\s+granted|i\s+approve\s+sending/i.test(blob)) {
    reasons.push("fake_approval");
    score += 60;
  }
  if (input.senderBlocked) {
    reasons.push("blocked_sender");
    score += 100;
  }
  if (
    input.senderPolicy === "known-only" &&
    !input.senderKnown &&
    !addressKnown
  ) {
    reasons.push("unknown_sender");
    score += 40;
  }
  if (input.overSenderBudget) {
    reasons.push("sender_budget");
    score += 30;
  }
  const auto = input.autoHeader || input.referencesCount > 100;
  if (auto) reasons.push("auto_mail");
  const hard = reasons.some((reason) =>
    [
      "instruction_like",
      "hidden_text",
      "bidi",
      "link_mismatch",
      "header_injection",
      "risky_attachment",
      "impersonation",
      "otp_phish",
      "fake_approval",
      "blocked_sender",
      "unknown_sender",
      "sender_budget",
      "auth_fail",
    ].includes(reason),
  );
  return {
    score,
    reasons,
    quarantine: hard,
    auto,
    text: input.text,
    hiddenRemoved: input.hiddenRemoved,
  };
}

export function attachmentRisk(name: string, type: string): "low" | "high" {
  const lower = name.toLowerCase();
  if (
    HIGH_TYPES.has(type.toLowerCase()) ||
    HIGH_EXT.some((ext) => lower.endsWith(ext))
  )
    return "high";
  return "low";
}

export function isAutoHeader(
  headers: { key: string; value: string }[],
): boolean {
  const get = (name: string) =>
    headers.find((header) => header.key.toLowerCase() === name)?.value ?? "";
  const auto = get("auto-submitted");
  if (auto && auto.toLowerCase() !== "no") return true;
  const precedence = get("precedence").toLowerCase();
  if (["bulk", "list", "junk"].includes(precedence)) return true;
  if (get("list-id")) return true;
  if (get("x-auto-response-suppress")) return true;
  return false;
}

export function referenceCount(references: string | undefined): number {
  if (!references) return 0;
  return references
    .split(/\s+/)
    .filter((part) => part.includes("@") || part.startsWith("<")).length;
}

const SECRET_PATTERNS: { code: string; pattern: RegExp }[] = [
  { code: "private_key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { code: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { code: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { code: "api_key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
];

export function scanSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) found.add(rule.code);
  }
  const cards = text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? [];
  for (const card of cards) {
    const digits = card.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits))
      found.add("card_number");
  }
  return [...found];
}

export function extractHosts(text: string): string[] {
  const hosts = new Set<string>();
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  for (const match of matches) {
    try {
      hosts.add(new URL(match).hostname.toLowerCase());
    } catch {
      // Ignore malformed URLs. They are not hosts we can classify.
    }
  }
  return [...hosts];
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0 && sum > 0;
}

function hasBidi(value: string): boolean {
  return /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/.test(value);
}

function hasZeroWidth(value: string): boolean {
  return /\u200B|\u200C|\u200D|\u2060|\uFEFF/.test(value);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function markdownLinks(text: string): { href: string; text: string }[] {
  const links: { href: string; text: string }[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
  for (const match of text.matchAll(pattern)) {
    links.push({ text: match[1] ?? "", href: match[2] ?? "" });
  }
  return links;
}

function hostsDisagree(href: string, visible: string): boolean {
  let hrefHost: string | null = null;
  try {
    hrefHost = new URL(href).hostname.toLowerCase();
  } catch {
    return false;
  }
  const visibleUrl = visible.match(/https?:\/\/[^\s<>"')]+/i)?.[0];
  const visibleHostLiteral = visible.match(
    /\b([a-z0-9.-]+\.[a-z]{2,})\b/i,
  )?.[1];
  const claimed = visibleUrl
    ? safeHost(visibleUrl)
    : visibleHostLiteral?.toLowerCase();
  if (!claimed || !hrefHost) return false;
  return parentDomain(claimed) !== parentDomain(hrefHost);
}

function hasForeignLink(text: string, mailDomain: string): boolean {
  return extractHosts(text).some((host) => !sameOrgHost(host, mailDomain));
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
