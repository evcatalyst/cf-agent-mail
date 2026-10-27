CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  domain TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  frozen INTEGER NOT NULL DEFAULT 0,
  outbound_paused INTEGER NOT NULL DEFAULT 0,
  sender_policy TEXT NOT NULL DEFAULT 'open',
  policy_mode TEXT NOT NULL DEFAULT 'strict',
  retention_raw_days INTEGER NOT NULL DEFAULT 90,
  retention_message_days INTEGER NOT NULL DEFAULT 365,
  retention_audit_days INTEGER NOT NULL DEFAULT 730,
  retention_draft_days INTEGER NOT NULL DEFAULT 30,
  wake_mode TEXT NOT NULL DEFAULT 'pull',
  wake_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  client_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX mailboxes_slug_domain ON mailboxes(slug, domain);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  class TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  subject_norm TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  participants_json TEXT NOT NULL DEFAULT '[]',
  preview TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL,
  hold INTEGER NOT NULL DEFAULT 0,
  legacy_thread_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX threads_mailbox_last ON threads(mailbox_id, last_message_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  origin TEXT NOT NULL,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  refs_json TEXT NOT NULL DEFAULT '[]',
  from_addr TEXT NOT NULL,
  from_name TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  auth_json TEXT NOT NULL DEFAULT '{}',
  trust TEXT NOT NULL DEFAULT 'unknown',
  auto INTEGER NOT NULL DEFAULT 0,
  visible_to_agent INTEGER NOT NULL DEFAULT 1,
  parse_status TEXT NOT NULL DEFAULT 'full',
  raw_key TEXT,
  sha256 TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  preview TEXT,
  received_at TEXT NOT NULL,
  idempotency_key TEXT,
  provider_message_id TEXT,
  draft_id TEXT
);

CREATE UNIQUE INDEX messages_idem ON messages(idempotency_key);
CREATE INDEX messages_rfc ON messages(mailbox_id, rfc_message_id);
CREATE INDEX messages_thread ON messages(thread_id, received_at);
CREATE INDEX messages_mailbox ON messages(mailbox_id, received_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  risk TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX attachments_message ON attachments(message_id);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  thread_id TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  html TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  labels_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  content_hash TEXT,
  in_reply_to TEXT,
  refs_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  client_id TEXT,
  review_id TEXT,
  provider_message_id TEXT,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  send_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX drafts_mailbox ON drafts(mailbox_id, updated_at);
CREATE UNIQUE INDEX drafts_client ON drafts(mailbox_id, client_id);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  draft_id TEXT,
  subject TEXT,
  state TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  risk_score INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  note TEXT,
  decision TEXT,
  decided_by TEXT,
  decided_at TEXT,
  via TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX review_state ON review_items(state, created_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  via TEXT NOT NULL
);

CREATE TABLE list_entries (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  list_type TEXT NOT NULL,
  entry TEXT NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX list_unique ON list_entries(mailbox_id, direction, list_type, entry);

CREATE TABLE suppressions (
  email TEXT NOT NULL,
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_event TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (email, scope)
);

CREATE TABLE message_events (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  provider_message_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  token_id TEXT,
  action TEXT NOT NULL,
  mailbox_id TEXT,
  thread_id TEXT,
  message_id TEXT,
  draft_id TEXT,
  content_hash TEXT,
  decision TEXT,
  ip_hash TEXT,
  result TEXT NOT NULL,
  detail_json TEXT
);

CREATE INDEX audit_ts ON audit_log(ts);

CREATE TABLE message_flags (
  message_id TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (message_id, code)
);

CREATE TABLE wake_events (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  sender TEXT,
  trust TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX wake_mailbox ON wake_events(mailbox_id, created_at);

CREATE TABLE outbound_attempts (
  id TEXT PRIMARY KEY,
  draft_id TEXT,
  mailbox_id TEXT,
  provider_message_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('global_freeze', '0');
INSERT INTO settings (key, value) VALUES ('schema_version', '1');

CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id,
  mailbox_id,
  subject,
  sender,
  recipients,
  body,
  tokenize = 'unicode61'
);

CREATE TABLE auth_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
