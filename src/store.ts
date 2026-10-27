import { parseJson } from "./ids";

export type MailboxRow = {
  id: string;
  slug: string;
  domain: string;
  address: string;
  display_name: string | null;
  enabled: number;
  frozen: number;
  outbound_paused: number;
  sender_policy: string;
  policy_mode: string;
  retention_raw_days: number;
  retention_message_days: number;
  retention_audit_days: number;
  retention_draft_days: number;
  wake_mode: string;
  wake_url: string | null;
  metadata_json: string;
  client_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TokenRow = {
  id: string;
  agent_id: string | null;
  class: string;
  label: string;
  scopes_json: string;
  hash: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type ThreadRow = {
  id: string;
  mailbox_id: string;
  subject: string;
  subject_norm: string;
  labels_json: string;
  participants_json: string;
  preview: string | null;
  message_count: number;
  last_message_at: string;
  hold: number;
  legacy_thread_id: string | null;
  created_at: string;
};

export type MessageRow = {
  id: string;
  thread_id: string;
  mailbox_id: string;
  direction: string;
  origin: string;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  refs_json: string;
  from_addr: string;
  from_name: string | null;
  to_json: string;
  cc_json: string;
  subject: string;
  text: string;
  size: number;
  auth_json: string;
  trust: string;
  auto: number;
  visible_to_agent: number;
  parse_status: string;
  raw_key: string | null;
  sha256: string | null;
  labels_json: string;
  preview: string | null;
  received_at: string;
  idempotency_key: string | null;
  provider_message_id: string | null;
  draft_id: string | null;
};

export type DraftRow = {
  id: string;
  mailbox_id: string;
  thread_id: string | null;
  to_json: string;
  cc_json: string;
  subject: string;
  text: string;
  html: string | null;
  attachments_json: string;
  labels_json: string;
  state: string;
  content_hash: string | null;
  in_reply_to: string | null;
  refs_json: string;
  created_by: string | null;
  client_id: string | null;
  review_id: string | null;
  provider_message_id: string | null;
  reason_codes_json: string;
  send_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewRow = {
  id: string;
  direction: string;
  mailbox_id: string;
  thread_id: string | null;
  message_id: string | null;
  draft_id: string | null;
  subject: string | null;
  state: string;
  reason_codes_json: string;
  risk_score: number;
  content_hash: string | null;
  note: string | null;
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  via: string | null;
  created_at: string;
  expires_at: string | null;
};

export type Principal = {
  tokenId: string;
  class: "agent" | "owner";
  agentId: string | null;
  scopes: string[];
  label: string;
  ipHash: string | null;
};

export async function getSetting(
  env: Env,
  key: string,
): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(
  env: Env,
  key: string,
  value: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

export async function audit(
  env: Env,
  entry: {
    actorType: string;
    actorId?: string | null;
    tokenId?: string | null;
    action: string;
    mailboxId?: string | null;
    threadId?: string | null;
    messageId?: string | null;
    draftId?: string | null;
    contentHash?: string | null;
    decision?: string | null;
    ipHash?: string | null;
    result: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const { newId, nowIso } = await import("./ids");
  await env.DB.prepare(
    `INSERT INTO audit_log (
      id, ts, actor_type, actor_id, token_id, action, mailbox_id, thread_id, message_id, draft_id,
      content_hash, decision, ip_hash, result, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("aud"),
      nowIso(),
      entry.actorType,
      entry.actorId ?? null,
      entry.tokenId ?? null,
      entry.action,
      entry.mailboxId ?? null,
      entry.threadId ?? null,
      entry.messageId ?? null,
      entry.draftId ?? null,
      entry.contentHash ?? null,
      entry.decision ?? null,
      entry.ipHash ?? null,
      entry.result,
      entry.detail ? JSON.stringify(entry.detail) : null,
    )
    .run();
}

export function mailboxJson(row: MailboxRow) {
  return {
    inboxId: row.address,
    email: row.address,
    displayName: row.display_name ?? undefined,
    metadata: parseJson<Record<string, string | number | boolean>>(
      row.metadata_json,
      {},
    ),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    enabled: row.enabled === 1,
    frozen: row.frozen === 1,
    policyMode: row.policy_mode,
    senderPolicy: row.sender_policy,
  };
}

export async function findMailbox(
  env: Env,
  addressOrId: string,
): Promise<MailboxRow | null> {
  return env.DB.prepare("SELECT * FROM mailboxes WHERE address = ? OR id = ?")
    .bind(addressOrId.toLowerCase(), addressOrId)
    .first<MailboxRow>();
}

export async function listMailboxes(env: Env): Promise<MailboxRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM mailboxes ORDER BY created_at DESC",
  ).all<MailboxRow>();
  return result.results ?? [];
}
