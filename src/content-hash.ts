import { sha256Hex } from "./crypto";

export async function contentHash(parts: {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string;
  attachmentHashes: string[];
  threadId: string | null;
}): Promise<string> {
  const canonical = JSON.stringify({
    from: parts.from.toLowerCase(),
    to: [...parts.to].map((item) => item.toLowerCase()).sort(),
    cc: [...parts.cc].map((item) => item.toLowerCase()).sort(),
    subject: parts.subject,
    text: parts.text,
    html: parts.html,
    attachmentHashes: [...parts.attachmentHashes].sort(),
    threadId: parts.threadId,
  });
  return sha256Hex(canonical);
}
