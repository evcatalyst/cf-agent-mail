export const TEMPLATE_KINDS = ["otp", "alert", "digest", "notify"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export function isTemplateKind(value: string): value is TemplateKind {
  return (TEMPLATE_KINDS as readonly string[]).includes(value);
}

export function renderTemplate(
  kind: TemplateKind,
  variables: Record<string, string>,
): { subject: string; text: string } {
  if (kind === "otp") {
    const code = variables.code ?? "";
    if (!/^\d{6}$/.test(code)) {
      throw new Error("otp code must be 6 digits");
    }
    return {
      subject: "Your sign-in code",
      text: `Your sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, you can ignore this message.\n\nThis is an automated message.`,
    };
  }
  if (kind === "alert") {
    const summary = bounded(variables.summary, 280);
    if (hasUrl(summary)) throw new Error("alert summary cannot contain a url");
    return {
      subject: "Account alert",
      text: `Alert: ${summary}\n\nThis is an automated message.`,
    };
  }
  if (kind === "digest") {
    const summary = bounded(variables.summary, 1000);
    if (hasUrl(summary)) throw new Error("digest summary cannot contain a url");
    return {
      subject: "Daily mail digest",
      text: `Digest:\n${summary}\n\nThis is an automated message.`,
    };
  }
  const summary = bounded(variables.summary, 500);
  if (hasUrl(summary)) throw new Error("notify summary cannot contain a url");
  return {
    subject: "Notification",
    text: `${summary}\n\nThis is an automated message.`,
  };
}

function bounded(value: string, max: number): string {
  let clean = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    clean += code < 32 ? " " : char;
  }
  clean = clean.trim();
  if (!clean) throw new Error("summary is required");
  if (clean.length > max) throw new Error("summary is too long");
  return clean;
}

function hasUrl(value: string): boolean {
  return /https?:\/\//i.test(value) || /\bwww\./i.test(value);
}
