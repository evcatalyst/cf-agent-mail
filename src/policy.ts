export type PolicyMode = "strict" | "known-auto" | "template-only";

export type ReviewAction = "send" | "review" | "deny";

export function normalizePolicyMode(value: string | undefined): PolicyMode {
  if (value === "known-auto" || value === "template-only" || value === "strict")
    return value;
  return "strict";
}

/**
 * Third-party mail waits in every mode while the relay is new.
 * known-auto is stored as configuration and still waits unless
 * ENFORCE_KNOWN_AUTO is explicitly turned on. template-only refuses free
 * text. System templates to an allow-listed owner address are the bypass.
 */
export function reviewDecision(input: {
  mode: PolicyMode;
  enforceKnownAuto: boolean;
  systemTemplate: boolean;
  ownerRecipient: boolean;
  thirdParty: boolean;
  knownRecipient: boolean;
  flagged: boolean;
  overLimit: boolean;
  inThread: boolean;
}): { action: ReviewAction; reasons: string[] } {
  if (input.systemTemplate && input.ownerRecipient) {
    return { action: "send", reasons: ["template_owner"] };
  }
  if (input.mode === "template-only") {
    return { action: "deny", reasons: ["template_only"] };
  }
  if (
    input.mode === "known-auto" &&
    input.enforceKnownAuto &&
    !input.thirdParty
  ) {
    return { action: "send", reasons: ["internal"] };
  }
  if (
    input.mode === "known-auto" &&
    input.enforceKnownAuto &&
    input.knownRecipient &&
    !input.flagged &&
    !input.overLimit &&
    input.inThread
  ) {
    return { action: "send", reasons: ["known_auto"] };
  }
  const reasons = ["third_party"];
  if (input.mode === "known-auto" && !input.enforceKnownAuto)
    reasons.push("known_auto_stubbed");
  if (!input.knownRecipient) reasons.push("first_contact");
  if (input.flagged) reasons.push("flagged");
  if (input.overLimit) reasons.push("over_limit");
  return { action: "review", reasons };
}
