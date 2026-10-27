import PostalMime from "postal-mime";
import type { Address, Email } from "postal-mime";
import {
  splitLocal,
  normalizeSubject,
  previewText,
  verifyThreadTag,
} from "./address";
import {
  attachmentRisk,
  classifyInbound,
  isAutoHeader,
  parseAuth,
  referenceCount,
  sanitizeInbound,
} from "./classify";
import { sha256Hex } from "./crypto";
import { newId, nowIso, parseJson } from "./ids";
import { LIMITS } from "./limits";
import {
  audit,
  getSetting,
  listMailboxes,
  setSetting,
  type MailboxRow,
} from "./store";
import { hmacHex } from "./crypto";

export type ParseJob = {
  rawKey: string;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: string;
  rawSize: number;
};

export async function handleParseJob(
  env: Env,
  job: ParseJob,
): Promise<{ status: string; messageId?: string }> {
  const object = await env.RAW.get(job.rawKey);
  if (!object) throw new Error("raw message missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const idem = await sha256Hex(
    concat(bytes, new TextEncoder().encode(job.envelopeTo.toLowerCase())),
  );
  const existing = await env.DB.prepare(
    "SELECT id FROM messages WHERE idempotency_key = ?",
  )
    .bind(idem)
    .first<{ id: string }>();
  if (existing) {
    if (existing.id) {
      const row = await env.DB.prepare(
        "SELECT raw_key FROM messages WHERE id = ?",
      )
        .bind(existing.id)
        .first<{ raw_key: string }>();
      if (row?.raw_key && row.raw_key !== job.rawKey)
        await env.RAW.delete(job.rawKey);
    }
    return { status: "duplicate", messageId: existing.id };
  }

  const target = splitLocal(job.envelopeTo);
  const mailbox = target
    ? await env.DB.prepare(
        "SELECT * FROM mailboxes WHERE slug = ? AND domain = ? AND enabled = 1",
      )
        .bind(target.slug, target.domain)
        .first<MailboxRow>()
    : null;
  if (!mailbox) return { status: "no_mailbox" };

  const cap = Number(env.PARSE_MAX_BYTES || LIMITS.parseMaxDefault);
  let parsed: Email | null = null;
  let parseStatus = "full";
  if (bytes.byteLength > cap) {
    parseStatus = "partial";
  } else {
    try {
      parsed = await PostalMime.parse(bytes);
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "parse_failed",
          rawKey: job.rawKey,
          error: error instanceof Error ? error.name : "error",
        }),
      );
      parseStatus = "partial";
    }
  }

  const headerList = parsed?.headers ?? [];
  const sanitized = sanitizeInbound({
    text: parsed?.text,
    html: typeof parsed?.html === "string" ? parsed.html : undefined,
    subject: parsed?.subject ?? "",
  });
  const from = firstAddress(parsed?.from) ?? {
    email: job.envelopeFrom.toLowerCase(),
  };
  const to = addressesOf(parsed?.to);
  const cc = addressesOf(parsed?.cc);
  const auth = parseAuth(
    headerList.map((header) => ({ key: header.key, value: header.value })),
  );
  const names = await env.DB.prepare(
    "SELECT slug, display_name, address FROM mailboxes",
  ).all<{
    slug: string;
    display_name: string | null;
    address: string;
  }>();
  const knownNames = (names.results ?? []).flatMap((row) =>
    [row.slug, row.display_name ?? ""].filter(Boolean),
  );
  const knownAddresses = (names.results ?? []).map((row) => row.address);
  const senderKnown = await knownSender(env, mailbox.id, from.email);
  const senderBlocked = await blockedSender(env, mailbox.id, from.email);
  const since = new Date(Date.now() - LIMITS.hourMs).toISOString();
  const budget = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ? AND from_addr = ? AND received_at >= ?",
  )
    .bind(mailbox.id, from.email, since)
    .first<{ n: number }>();
  const references = parsed?.references ?? "";
  const classification = classifyInbound({
    text: sanitized.text,
    subject: sanitized.subject,
    headerInjection: sanitized.headerInjection,
    hiddenRemoved: sanitized.hiddenRemoved,
    linkMismatch: sanitized.linkMismatch,
    bidi: sanitized.bidi,
    auth,
    fromName: from.name,
    fromAddr: from.email,
    knownNames,
    knownAddresses,
    riskyAttachment: (parsed?.attachments ?? []).some(
      (item) => attachmentRisk(item.filename ?? "", item.mimeType) === "high",
    ),
    autoHeader: isAutoHeader(
      headerList.map((header) => ({ key: header.key, value: header.value })),
    ),
    referencesCount: referenceCount(references),
    senderPolicy: mailbox.sender_policy,
    senderKnown,
    senderBlocked,
    overSenderBudget: (budget?.n ?? 0) >= LIMITS.senderWakeBudget,
    mailDomain: env.MAIL_DOMAIN,
  });

  const optOut = /^\s*opt[ -]?out\s*$/i.test(sanitized.text);
  const signedThread = target?.tag
    ? await verifyThreadTag(target.tag, env.REPLY_HMAC_KEY)
    : null;
  const thread = await resolveThread(env, {
    mailboxId: mailbox.id,
    subject: sanitized.subject || "(no subject)",
    inReplyTo: parsed?.inReplyTo,
    references,
    signedThread,
    from: from.email,
    to: to.map((item) => item.email),
  });

  const messageId = newId("msg");
  const receivedAt = job.receivedAt || nowIso();
  const labels = ["unread"];
  if (classification.quarantine) labels.push("quarantine");
  if (
    classification.reasons.includes("blocked_sender") ||
    classification.reasons.includes("auth_fail")
  )
    labels.push("spam");
  const visible = classification.quarantine ? 0 : 1;
  const rfc = parsed?.messageId ?? null;
  const preview = previewText(sanitized.text || sanitized.subject || "");
  const statements: D1PreparedStatement[] = [];
  if (thread.created) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO threads (
          id, mailbox_id, subject, subject_norm, labels_json, participants_json, preview, message_count, last_message_at, hold, created_at
        ) VALUES (?, ?, ?, ?, '[]', ?, ?, 1, ?, 0, ?)`,
      ).bind(
        thread.id,
        mailbox.id,
        thread.subject,
        normalizeSubject(thread.subject),
        JSON.stringify(unique([from.email, ...to.map((item) => item.email)])),
        preview,
        receivedAt,
        receivedAt,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE threads SET last_message_at = ?, message_count = message_count + 1, preview = ?,
         participants_json = ? WHERE id = ?`,
      ).bind(
        receivedAt,
        preview,
        JSON.stringify(thread.participants),
        thread.id,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO messages (
        id, thread_id, mailbox_id, direction, origin, rfc_message_id, in_reply_to, refs_json, from_addr, from_name,
        to_json, cc_json, subject, text, size, auth_json, trust, auto, visible_to_agent, parse_status, raw_key, sha256,
        labels_json, preview, received_at, idempotency_key
      ) VALUES (?, ?, ?, 'inbound', 'external', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      messageId,
      thread.id,
      mailbox.id,
      rfc,
      parsed?.inReplyTo ?? null,
      JSON.stringify(references.split(/\s+/).filter(Boolean)),
      from.email,
      from.name ?? null,
      JSON.stringify(to.map((item) => item.email)),
      JSON.stringify(cc.map((item) => item.email)),
      sanitized.subject || "(no subject)",
      sanitized.text,
      bytes.byteLength,
      JSON.stringify(auth),
      "unknown",
      classification.auto ? 1 : 0,
      visible,
      parseStatus,
      job.rawKey,
      idem,
      JSON.stringify(labels),
      preview,
      receivedAt,
      idem,
    ),
  );
  statements.push(
    env.DB.prepare(
      "INSERT INTO messages_fts (message_id, mailbox_id, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      messageId,
      mailbox.id,
      sanitized.subject,
      from.email,
      [...to, ...cc].map((item) => item.email).join(" "),
      sanitized.text,
    ),
  );
  for (const reason of classification.reasons) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO message_flags (message_id, code, detail) VALUES (?, ?, ?)",
      ).bind(messageId, reason, null),
    );
  }
  if (classification.quarantine) {
    const reviewId = newId("rev");
    statements.push(
      env.DB.prepare(
        `INSERT INTO review_items (
          id, direction, mailbox_id, thread_id, message_id, subject, state, reason_codes_json, risk_score, created_at, expires_at
        ) VALUES (?, 'inbound', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      ).bind(
        reviewId,
        mailbox.id,
        thread.id,
        messageId,
        sanitized.subject || "(no subject)",
        JSON.stringify(classification.reasons),
        classification.score,
        receivedAt,
        new Date(Date.parse(receivedAt) + LIMITS.quarantineTtlMs).toISOString(),
      ),
    );
  }
  await env.DB.batch(statements);

  if (parsed && parseStatus === "full") {
    await storeAttachments(env, parsed, {
      messageId,
      threadId: thread.id,
      mailboxId: mailbox.id,
    });
  }
  if (optOut) {
    await env.DB.prepare(
      "INSERT INTO suppressions (email, scope, reason, source_event, created_at) VALUES (?, ?, 'opt_out', 'inbound', ?) ON CONFLICT(email, scope) DO NOTHING",
    )
      .bind(from.email, mailbox.address, nowIso())
      .run();
  }

  const globalFreeze = (await getSetting(env, "global_freeze")) === "1";
  if (
    visible &&
    !classification.auto &&
    !globalFreeze &&
    mailbox.frozen === 0
  ) {
    await enqueueWake(env, {
      mailboxId: mailbox.id,
      threadId: thread.id,
      messageId,
      sender: from.email,
      trust: "unknown",
      receivedAt,
      wakeUrl: mailbox.wake_url,
    });
  }
  await audit(env, {
    actorType: "system",
    action: classification.quarantine
      ? "message.quarantine"
      : "message.deliver",
    mailboxId: mailbox.id,
    threadId: thread.id,
    messageId,
    result: "ok",
    detail: {
      reasons: classification.reasons,
      score: classification.score,
      parseStatus,
    },
  });
  return {
    status: classification.quarantine ? "held" : "delivered",
    messageId,
  };
}

export async function handleProviderEvent(
  env: Env,
  body: Record<string, unknown>,
): Promise<void> {
  const type = String(body.type ?? "unknown");
  const providerId = typeof body.messageId === "string" ? body.messageId : null;
  const recipient =
    typeof body.recipient === "string" ? body.recipient.toLowerCase() : null;
  const bounce = body.bounce as { type?: string } | undefined;
  await env.DB.prepare(
    "INSERT INTO message_events (id, provider_message_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      newId("evt"),
      providerId,
      type,
      JSON.stringify({
        type,
        messageId: providerId,
        recipient,
        bounceType: bounce?.type ?? null,
      }),
      nowIso(),
    )
    .run();
  const hard =
    type.includes("complain") ||
    (type.includes("bounce") && bounce?.type === "hard");
  if (hard && recipient) {
    await env.DB.prepare(
      "INSERT INTO suppressions (email, scope, reason, source_event, created_at) VALUES (?, 'account', ?, ?, ?) ON CONFLICT(email, scope) DO NOTHING",
    )
      .bind(
        recipient,
        type.includes("complain") ? "complaint" : "hard_bounce",
        type,
        nowIso(),
      )
      .run();
    if (providerId) {
      const draft = await env.DB.prepare(
        "SELECT mailbox_id FROM drafts WHERE provider_message_id = ?",
      )
        .bind(providerId)
        .first<{ mailbox_id: string }>();
      if (draft) {
        const count = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM message_events e
           JOIN drafts d ON d.provider_message_id = e.provider_message_id
           WHERE d.mailbox_id = ? AND (e.type LIKE '%complain%' OR e.payload_json LIKE '%hard%')`,
        )
          .bind(draft.mailbox_id)
          .first<{ n: number }>();
        if ((count?.n ?? 0) >= 3) {
          await env.DB.prepare(
            "UPDATE mailboxes SET outbound_paused = 1, updated_at = ? WHERE id = ?",
          )
            .bind(nowIso(), draft.mailbox_id)
            .run();
          await audit(env, {
            actorType: "system",
            action: "mailbox.pause",
            mailboxId: draft.mailbox_id,
            result: "ok",
            detail: { reason: "complaints_or_bounces" },
          });
        }
      }
    }
  }
}

export async function handleWake(env: Env, body: WakeBody): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO wake_events (id, mailbox_id, thread_id, message_id, sender, trust, received_at, created_at, delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      newId("wake"),
      body.mailboxId,
      body.threadId,
      body.messageId,
      body.sender,
      body.trust,
      body.receivedAt,
      nowIso(),
    )
    .run();
  if (!body.wakeUrl) return;
  const payload = {
    mailboxId: body.mailboxId,
    threadId: body.threadId,
    messageId: body.messageId,
    sender: body.sender,
    receivedAt: body.receivedAt,
    trust: body.trust,
  };
  const raw = JSON.stringify(payload);
  const signature = await hmacHex(env.WEBHOOK_SIGNING_KEY, raw);
  const response = await fetch(body.wakeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cf-agent-mail-signature": `sha256=${signature}`,
    },
    body: raw,
  });
  if (!response.ok) throw new Error(`wake webhook ${response.status}`);
}

export async function runRetention(
  env: Env,
  now = new Date(),
): Promise<{ deletedMessages: number }> {
  let deletedMessages = 0;
  const mailboxes = await listMailboxes(env);
  for (const mailbox of mailboxes) {
    const messageCutoff = new Date(
      now.getTime() - mailbox.retention_message_days * LIMITS.dayMs,
    ).toISOString();
    const rawCutoff = new Date(
      now.getTime() - mailbox.retention_raw_days * LIMITS.dayMs,
    ).toISOString();
    const draftCutoff = new Date(
      now.getTime() - mailbox.retention_draft_days * LIMITS.dayMs,
    ).toISOString();
    const auditCutoff = new Date(
      now.getTime() - mailbox.retention_audit_days * LIMITS.dayMs,
    ).toISOString();
    const old = await env.DB.prepare(
      `SELECT m.id, m.raw_key FROM messages m
       JOIN threads t ON t.id = m.thread_id
       WHERE m.mailbox_id = ? AND m.received_at < ? AND t.hold = 0`,
    )
      .bind(mailbox.id, messageCutoff)
      .all<{ id: string; raw_key: string | null }>();
    for (const row of old.results ?? []) {
      await deleteMessage(env, row.id, row.raw_key);
      deletedMessages += 1;
    }
    const raws = await env.DB.prepare(
      "SELECT id, raw_key FROM messages WHERE mailbox_id = ? AND raw_key IS NOT NULL AND received_at < ?",
    )
      .bind(mailbox.id, rawCutoff)
      .all<{ id: string; raw_key: string }>();
    for (const row of raws.results ?? []) {
      await env.RAW.delete(row.raw_key);
      await env.DB.prepare("UPDATE messages SET raw_key = NULL WHERE id = ?")
        .bind(row.id)
        .run();
    }
    await env.DB.prepare(
      "DELETE FROM drafts WHERE mailbox_id = ? AND updated_at < ? AND state IN ('sent', 'rejected', 'expired', 'cancelled')",
    )
      .bind(mailbox.id, draftCutoff)
      .run();
    await env.DB.prepare(
      "DELETE FROM audit_log WHERE mailbox_id = ? AND ts < ?",
    )
      .bind(mailbox.id, auditCutoff)
      .run();
  }
  const expiredInbound = await env.DB.prepare(
    "SELECT id, message_id FROM review_items WHERE direction = 'inbound' AND state = 'pending' AND expires_at < ?",
  )
    .bind(now.toISOString())
    .all<{ id: string; message_id: string | null }>();
  for (const row of expiredInbound.results ?? []) {
    if (row.message_id) {
      const message = await env.DB.prepare(
        "SELECT raw_key FROM messages WHERE id = ?",
      )
        .bind(row.message_id)
        .first<{ raw_key: string | null }>();
      await deleteMessage(env, row.message_id, null);
      if (message?.raw_key) {
        // Raw follows its own retention. Leave the object in place.
      }
    }
    await env.DB.prepare(
      "UPDATE review_items SET state = 'expired', decision = 'expired' WHERE id = ?",
    )
      .bind(row.id)
      .run();
  }
  await env.DB.prepare(
    "UPDATE review_items SET state = 'expired', decision = 'expired' WHERE direction = 'outbound' AND state = 'pending' AND expires_at < ?",
  )
    .bind(now.toISOString())
    .run();
  await env.DB.prepare(
    "UPDATE drafts SET state = 'expired', updated_at = ? WHERE state = 'pending_approval' AND expires_at < ?",
  )
    .bind(now.toISOString(), now.toISOString())
    .run();
  await setSetting(env, "last_retention_at", now.toISOString());
  return { deletedMessages };
}

export async function enqueueWake(env: Env, body: WakeBody): Promise<void> {
  await env.WAKE_QUEUE.send(body);
  if (env.INLINE_PARSE === "1") await handleWake(env, body);
}

async function resolveThread(
  env: Env,
  input: {
    mailboxId: string;
    subject: string;
    inReplyTo?: string;
    references: string;
    signedThread: string | null;
    from: string;
    to: string[];
  },
): Promise<{
  id: string;
  created: boolean;
  subject: string;
  participants: string[];
}> {
  const refs = [input.inReplyTo, ...input.references.split(/\s+/)].filter(
    (item): item is string => Boolean(item),
  );
  for (const ref of refs) {
    const message = await env.DB.prepare(
      "SELECT thread_id FROM messages WHERE mailbox_id = ? AND (rfc_message_id = ? OR provider_message_id = ? OR id = ?) LIMIT 1",
    )
      .bind(input.mailboxId, ref, ref, ref.replace(/[<>]/g, ""))
      .first<{ thread_id: string }>();
    if (message) return loadThread(env, message.thread_id, input);
  }
  if (input.signedThread) {
    const thread = await env.DB.prepare(
      "SELECT id FROM threads WHERE id = ? AND mailbox_id = ?",
    )
      .bind(input.signedThread, input.mailboxId)
      .first<{ id: string }>();
    if (thread) return loadThread(env, thread.id, input);
  }
  const norm = normalizeSubject(input.subject);
  if (norm) {
    const since = new Date(Date.now() - LIMITS.threadWindowMs).toISOString();
    const candidate = await env.DB.prepare(
      "SELECT id, participants_json, subject FROM threads WHERE mailbox_id = ? AND subject_norm = ? AND last_message_at >= ? ORDER BY last_message_at DESC LIMIT 1",
    )
      .bind(input.mailboxId, norm, since)
      .first<{ id: string; participants_json: string; subject: string }>();
    if (candidate) {
      const participants = parseJson<string[]>(candidate.participants_json, []);
      const incoming = new Set([input.from, ...input.to]);
      if (participants.some((address) => incoming.has(address)))
        return loadThread(env, candidate.id, input);
    }
  }
  return {
    id: newId("thd"),
    created: true,
    subject: input.subject,
    participants: unique([input.from, ...input.to]),
  };
}

async function loadThread(
  env: Env,
  id: string,
  input: { from: string; to: string[] },
): Promise<{
  id: string;
  created: boolean;
  subject: string;
  participants: string[];
}> {
  const thread = await env.DB.prepare(
    "SELECT subject, participants_json FROM threads WHERE id = ?",
  )
    .bind(id)
    .first<{ subject: string; participants_json: string }>();
  const participants = unique([
    ...(thread ? parseJson<string[]>(thread.participants_json, []) : []),
    input.from,
    ...input.to,
  ]);
  return {
    id,
    created: false,
    subject: thread?.subject ?? "(no subject)",
    participants,
  };
}

async function storeAttachments(
  env: Env,
  parsed: Email,
  ids: { messageId: string; threadId: string; mailboxId: string },
): Promise<void> {
  let index = 0;
  for (const attachment of parsed.attachments ?? []) {
    if (index >= 32) break;
    index += 1;
    const bytes = attachmentBytes(attachment.content);
    if (bytes.byteLength > LIMITS.outboundMaxBytes) continue;
    const id = newId("att");
    const key = `att/${ids.mailboxId}/${id}`;
    const risk = attachmentRisk(
      attachment.filename ?? "file",
      attachment.mimeType || "application/octet-stream",
    );
    await env.ATTACHMENTS.put(key, bytes, {
      customMetadata: {
        name: attachment.filename ?? "file",
        type: attachment.mimeType || "application/octet-stream",
        risk,
      },
    });
    await env.DB.prepare(
      "INSERT INTO attachments (id, message_id, thread_id, mailbox_id, name, type, size, sha256, r2_key, risk, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        ids.messageId,
        ids.threadId,
        ids.mailboxId,
        attachment.filename ?? "file",
        attachment.mimeType || "application/octet-stream",
        bytes.byteLength,
        await sha256Hex(bytes),
        key,
        risk,
        nowIso(),
      )
      .run();
  }
}

async function deleteMessage(
  env: Env,
  id: string,
  rawKey: string | null,
): Promise<void> {
  const attachments = await env.DB.prepare(
    "SELECT r2_key FROM attachments WHERE message_id = ?",
  )
    .bind(id)
    .all<{ r2_key: string }>();
  for (const attachment of attachments.results ?? [])
    await env.ATTACHMENTS.delete(attachment.r2_key);
  if (rawKey) await env.RAW.delete(rawKey);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(id),
    env.DB.prepare("DELETE FROM message_flags WHERE message_id = ?").bind(id),
    env.DB.prepare("DELETE FROM messages_fts WHERE message_id = ?").bind(id),
    env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id),
  ]);
}

async function knownSender(
  env: Env,
  mailboxId: string,
  email: string,
): Promise<boolean> {
  const domain = email.split("@")[1] ?? "";
  const row = await env.DB.prepare(
    "SELECT id FROM list_entries WHERE mailbox_id = ? AND direction = 'receive' AND list_type = 'allow' AND (entry = ? OR entry = ?) LIMIT 1",
  )
    .bind(mailboxId, email, domain)
    .first<{ id: string }>();
  return Boolean(row);
}

async function blockedSender(
  env: Env,
  mailboxId: string,
  email: string,
): Promise<boolean> {
  const domain = email.split("@")[1] ?? "";
  const row = await env.DB.prepare(
    "SELECT id FROM list_entries WHERE mailbox_id = ? AND direction = 'receive' AND list_type = 'block' AND (entry = ? OR entry = ?) LIMIT 1",
  )
    .bind(mailboxId, email, domain)
    .first<{ id: string }>();
  return Boolean(row);
}

function addressesOf(
  value: Address[] | undefined,
): { email: string; name?: string }[] {
  const out: { email: string; name?: string }[] = [];
  for (const item of value ?? []) {
    if ("group" in item && item.group) {
      for (const member of item.group)
        out.push({
          email: member.address.toLowerCase(),
          name: member.name || undefined,
        });
    } else if ("address" in item && item.address) {
      out.push({
        email: item.address.toLowerCase(),
        name: item.name || undefined,
      });
    }
  }
  return out;
}

function firstAddress(
  value: Address | undefined,
): { email: string; name?: string } | null {
  if (!value) return null;
  return addressesOf([value])[0] ?? null;
}

function attachmentBytes(
  content: ArrayBuffer | Uint8Array | string,
): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

function unique(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.toLowerCase()).filter(Boolean)),
  ];
}

type WakeBody = {
  mailboxId: string;
  threadId: string;
  messageId: string;
  sender: string;
  trust: string;
  receivedAt: string;
  wakeUrl?: string | null;
};
