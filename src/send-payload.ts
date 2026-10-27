import { stripCrlf } from "./address";
import { FORBIDDEN_HEADERS, OUTBOUND_FOOTER } from "./limits";

export type OutboundPayload = {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers: Record<string, string>;
};

export function withOutboundFooter(text: string): string {
  if (text.includes(OUTBOUND_FOOTER.trim())) return text;
  return `${text}${OUTBOUND_FOOTER}`;
}

export function buildSendPayload(input: {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  autoSubmitted?: boolean;
  extraHeaders?: Record<string, string>;
}): OutboundPayload {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) continue;
    headers[canonicalHeader(name)] = stripCrlf(value);
  }
  if (input.inReplyTo) headers["In-Reply-To"] = stripCrlf(input.inReplyTo);
  if (input.references && input.references.length > 0) {
    headers.References = input.references
      .map((item) => stripCrlf(item))
      .filter(Boolean)
      .slice(-10)
      .join(" ");
  }
  if (input.autoSubmitted) headers["Auto-Submitted"] = "auto-generated";
  delete headers["Message-ID"];
  delete headers["Message-Id"];
  delete headers.Date;
  return {
    from: input.from,
    to: input.to,
    cc: input.cc ?? [],
    subject: stripCrlf(input.subject).slice(0, 998),
    text: input.text,
    html: input.html,
    replyTo: input.replyTo,
    headers,
  };
}

export function payloadHasForbiddenHeaders(payload: OutboundPayload): boolean {
  return Object.keys(payload.headers).some((name) =>
    FORBIDDEN_HEADERS.has(name.toLowerCase()),
  );
}

function canonicalHeader(name: string): string {
  return name
    .split("-")
    .map((part) =>
      part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part,
    )
    .join("-");
}
