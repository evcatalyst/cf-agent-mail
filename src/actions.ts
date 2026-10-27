import {
  isValidSlug,
  normalizeSubject,
  parseAddress,
  previewText,
  sameOrgHost,
  signThreadTag,
  stripCrlf,
} from "./address";
import { assertScope, hasScope, isOwnerAddress } from "./authz";
import { extractHosts, scanSecrets } from "./classify";
import { contentHash } from "./content-hash";
import { decodeBase64, sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  asString,
  clampLimit,
  decodePage,
  encodePage,
  newId,
  nowIso,
  parseJson,
} from "./ids";
import { LIMITS } from "./limits";
import { ftsQuery } from "./address";
import { reviewDecision, normalizePolicyMode } from "./policy";
import {
  buildSendPayload,
  withOutboundFooter,
  type OutboundPayload,
} from "./send-payload";
import { boxStub, globalStub } from "./stubs";
import {
  audit,
  findMailbox,
  getSetting,
  listMailboxes,
  mailboxJson,
  setSetting,
  type DraftRow,
  type MailboxRow,
  type MessageRow,
  type Principal,
  type ReviewRow,
  type ThreadRow,
} from "./store";
import { attachmentRisk } from "./classify";
import { isTemplateKind, renderTemplate, type TemplateKind } from "./templates";
import { enqueueWake } from "./pipeline";

export async function listInboxes(
  env: Env,
  principal: Principal,
  args: { limit?: number; pageToken?: string },
) {
  const limit = clampLimit(args.limit);
  const offset = decodePage(args.pageToken);
  const rows = (await listMailboxes(env)).filter(
    (row) =>
      canSee(principal, row.address) &&
      (principal.class === "owner" || row.enabled === 1),
  );
  const slice = rows.slice(offset, offset + limit);
  return page(
    { inboxes: slice.map(mailboxJson) },
    slice.length,
    limit,
    offset,
    rows.length,
  );
}

export async function searchInboxes(
  env: Env,
  principal: Principal,
  args: { q: string; limit?: number; pageToken?: string },
) {
  const q = args.q.trim().toLowerCase();
  if (q.length < 2)
    throw new ApiError(400, "invalid", "Query must be at least 2 characters");
  const rows = (await listMailboxes(env)).filter((row) => {
    if (!canSee(principal, row.address)) return false;
    return (
      row.address.includes(q) ||
      (row.display_name ?? "").toLowerCase().includes(q) ||
      row.slug.includes(q)
    );
  });
  const limit = clampLimit(args.limit);
  const offset = decodePage(args.pageToken);
  const slice = rows.slice(offset, offset + limit);
  return page(
    { inboxes: slice.map(mailboxJson) },
    slice.length,
    limit,
    offset,
    rows.length,
  );
}

export async function getInbox(
  env: Env,
  principal: Principal,
  inboxId: string,
) {
  const mailbox = await requireMailbox(env, principal, inboxId, "mail:read");
  return mailboxJson(mailbox);
}

export async function createInbox(
  env: Env,
  principal: Principal,
  args: {
    username?: string;
    domain?: string;
    displayName?: string;
    clientId?: string;
    metadata?: Record<string, string | number | boolean>;
  },
) {
  assertScope(principal, "admin");
  if (args.clientId) {
    const existing = await env.DB.prepare(
      "SELECT * FROM mailboxes WHERE client_id = ?",
    )
      .bind(args.clientId)
      .first<MailboxRow>();
    if (existing) return mailboxJson(existing);
  }
  const slug = (args.username ?? "").toLowerCase();
  if (!isValidSlug(slug))
    throw new ApiError(400, "invalid", "Username must be a lowercase slug");
  const domain = (args.domain ?? env.MAIL_DOMAIN).toLowerCase();
  if (domain !== env.MAIL_DOMAIN)
    throw new ApiError(
      400,
      "invalid",
      "Only the configured mail domain can be used",
    );
  const address = `${slug}@${domain}`;
  const ts = nowIso();
  const id = newId("mbx");
  await env.DB.prepare(
    `INSERT INTO mailboxes (
      id, slug, domain, address, display_name, metadata_json, client_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      slug,
      domain,
      address,
      args.displayName ? stripCrlf(args.displayName) : null,
      JSON.stringify(args.metadata ?? {}),
      args.clientId ?? null,
      ts,
      ts,
    )
    .run();
  await audit(env, {
    actorType: principal.class,
    actorId: principal.label,
    tokenId: principal.tokenId,
    action: "inbox.create",
    mailboxId: id,
    result: "ok",
  });
  const created = await findMailbox(env, address);
  if (!created) throw new ApiError(500, "error", "Inbox was not stored");
  return { ...mailboxJson(created), routingRequired: true };
}

export async function updateInbox(
  env: Env,
  principal: Principal,
  inboxId: string,
  args: {
    displayName?: string;
    metadata?: Record<string, string | number | boolean | null> | null;
    policyMode?: string;
    senderPolicy?: string;
  },
) {
  const mailbox = await requireMailbox(env, principal, inboxId, "mail:write");
  const owner = principal.class === "owner";
  if ((args.policyMode || args.senderPolicy) && !owner)
    throw new ApiError(403, "forbidden", "Only the owner can change policy");
  let metadata = parseJson<Record<string, string | number | boolean>>(
    mailbox.metadata_json,
    {},
  );
  if (args.metadata === null) metadata = {};
  else if (args.metadata) {
    for (const [key, value] of Object.entries(args.metadata)) {
      if (value === null) delete metadata[key];
      else metadata[key] = value;
    }
  }
  const display =
    args.displayName !== undefined
      ? stripCrlf(args.displayName)
      : mailbox.display_name;
  const mode = args.policyMode
    ? normalizePolicyMode(args.policyMode)
    : mailbox.policy_mode;
  const sender =
    args.senderPolicy &&
    ["open", "known-only", "allow-list"].includes(args.senderPolicy)
      ? args.senderPolicy
      : mailbox.sender_policy;
  const ts = nowIso();
  await env.DB.prepare(
    "UPDATE mailboxes SET display_name = ?, metadata_json = ?, policy_mode = ?, sender_policy = ?, updated_at = ? WHERE id = ?",
  )
    .bind(display, JSON.stringify(metadata), mode, sender, ts, mailbox.id)
    .run();
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "inbox.update",
    mailboxId: mailbox.id,
    result: "ok",
  });
  const updated = await findMailbox(env, mailbox.id);
  if (!updated) throw new ApiError(404, "not_found", "Inbox not found");
  return mailboxJson(updated);
}

export async function deleteInbox(
  env: Env,
  principal: Principal,
  inboxId: string,
) {
  assertScope(principal, "admin");
  const mailbox = await requireMailbox(env, principal, inboxId, "admin");
  const tokens = await env.DB.prepare(
    "SELECT scopes_json, revoked_at FROM tokens",
  ).all<{ scopes_json: string; revoked_at: string | null }>();
  const live = (tokens.results ?? []).some(
    (token) => !token.revoked_at && token.scopes_json.includes(mailbox.address),
  );
  if (live)
    throw new ApiError(
      409,
      "conflict",
      "Revoke tokens for this inbox before disabling it",
    );
  await env.DB.prepare(
    "UPDATE mailboxes SET enabled = 0, updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), mailbox.id)
    .run();
  await audit(env, {
    actorType: "owner",
    tokenId: principal.tokenId,
    action: "inbox.disable",
    mailboxId: mailbox.id,
    result: "ok",
  });
  return { success: true as const };
}

export async function listThreads(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:read",
  );
  return queryThreads(env, principal, mailbox, args, false);
}

export async function searchThreads(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:search",
  );
  const match = ftsQuery(String(args.q ?? ""));
  if (!match) return { count: 0, threads: [] };
  const ids = await searchIds(
    env,
    match,
    mailbox.id,
    principal.class !== "owner",
  );
  const threads = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const message = await env.DB.prepare(
      "SELECT thread_id FROM messages WHERE id = ?",
    )
      .bind(id)
      .first<{ thread_id: string }>();
    if (!message || seen.has(message.thread_id)) continue;
    seen.add(message.thread_id);
    const thread = await env.DB.prepare("SELECT * FROM threads WHERE id = ?")
      .bind(message.thread_id)
      .first<ThreadRow>();
    if (thread) threads.push(await threadJson(env, thread, false));
  }
  return { count: threads.length, threads };
}

export async function getThread(
  env: Env,
  principal: Principal,
  args: {
    inboxId: string;
    threadId: string;
    limit?: number;
    pageToken?: string;
  },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:read",
  );
  const thread = await requireThread(env, mailbox.id, args.threadId);
  const limit = clampLimit(args.limit);
  const offset = decodePage(args.pageToken);
  const agent = principal.class !== "owner";
  const messages = await listThreadMessages(
    env,
    thread.id,
    agent,
    limit,
    offset,
  );
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "thread.read",
    mailboxId: mailbox.id,
    threadId: thread.id,
    ipHash: principal.ipHash,
    result: "ok",
  });
  const body = await threadJson(env, thread, true);
  return {
    ...body,
    messages: messages.map((message) => messageJson(message, mailbox.domain)),
    nextPageToken:
      messages.length === limit ? encodePage(offset + limit) : undefined,
  };
}

export async function updateThread(
  env: Env,
  principal: Principal,
  args: {
    inboxId: string;
    threadId: string;
    addLabels?: string[];
    removeLabels?: string[];
  },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:write",
  );
  const thread = await requireThread(env, mailbox.id, args.threadId);
  const labels = mergeLabels(
    parseJson<string[]>(thread.labels_json, []),
    args.addLabels,
    args.removeLabels,
  );
  await env.DB.prepare("UPDATE threads SET labels_json = ? WHERE id = ?")
    .bind(JSON.stringify(labels), thread.id)
    .run();
  const messages = await env.DB.prepare(
    "SELECT id, labels_json FROM messages WHERE thread_id = ?",
  )
    .bind(thread.id)
    .all<{ id: string; labels_json: string }>();
  for (const message of messages.results ?? []) {
    const next = mergeLabels(
      parseJson<string[]>(message.labels_json, []),
      args.addLabels,
      args.removeLabels,
    );
    await env.DB.prepare("UPDATE messages SET labels_json = ? WHERE id = ?")
      .bind(JSON.stringify(next), message.id)
      .run();
  }
  const updated = await requireThread(env, mailbox.id, thread.id);
  return threadJson(env, updated, false);
}

export async function deleteThread(
  env: Env,
  principal: Principal,
  args: { inboxId: string; threadId: string },
) {
  return updateThread(env, principal, { ...args, addLabels: ["trash"] });
}

export async function listMessages(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:read",
  );
  const limit = clampLimit(args.limit);
  const offset = decodePage(
    typeof args.pageToken === "string" ? args.pageToken : undefined,
  );
  const where = ["mailbox_id = ?"];
  const binds: unknown[] = [mailbox.id];
  if (principal.class !== "owner") where.push("visible_to_agent = 1");
  if (!args.includeTrash) where.push("instr(labels_json, '\"trash\"') = 0");
  if (!args.includeSpam) where.push("instr(labels_json, '\"spam\"') = 0");
  addLabelFilter(where, binds, args.labels);
  addTimeFilter(where, binds, args.before, args.after, "received_at");
  for (const value of asStrings(args.from)) {
    where.push("instr(lower(from_addr), ?) > 0");
    binds.push(value.toLowerCase());
  }
  for (const value of asStrings(args.subject)) {
    where.push("instr(lower(subject), ?) > 0");
    binds.push(value.toLowerCase());
  }
  const order = args.ascending === true ? "ASC" : "DESC";
  const result = await env.DB.prepare(
    `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY received_at ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<MessageRow>();
  const messages = (result.results ?? []).map((message) =>
    messageJson(message, mailbox.domain, false),
  );
  return page(
    { messages },
    messages.length,
    limit,
    offset,
    offset + messages.length + (messages.length === limit ? 1 : 0),
  );
}

export async function searchMessages(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:search",
  );
  const match = ftsQuery(String(args.q ?? ""));
  if (!match) return { count: 0, messages: [] };
  const ids = await searchIds(
    env,
    match,
    mailbox.id,
    principal.class !== "owner",
  );
  const messages = [];
  for (const id of ids) {
    const message = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
      .bind(id)
      .first<MessageRow>();
    if (!message) continue;
    if (typeof args.before === "string" && message.received_at >= args.before)
      continue;
    if (typeof args.after === "string" && message.received_at < args.after)
      continue;
    messages.push(messageJson(message, mailbox.domain, false));
  }
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "message.search",
    mailboxId: mailbox.id,
    ipHash: principal.ipHash,
    result: "ok",
  });
  return { count: messages.length, messages };
}

export async function getMessage(
  env: Env,
  principal: Principal,
  args: { inboxId: string; messageId: string },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:read",
  );
  const message = await requireMessage(
    env,
    mailbox,
    args.messageId,
    principal.class !== "owner",
  );
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "message.read",
    mailboxId: mailbox.id,
    threadId: message.thread_id,
    messageId: message.id,
    ipHash: principal.ipHash,
    result: "ok",
  });
  return messageJson(message, mailbox.domain, true);
}

export async function updateMessage(
  env: Env,
  principal: Principal,
  args: {
    inboxId: string;
    messageId: string;
    addLabels?: string[];
    removeLabels?: string[];
  },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:write",
  );
  const message = await requireMessage(
    env,
    mailbox,
    args.messageId,
    principal.class !== "owner",
  );
  const labels = mergeLabels(
    parseJson<string[]>(message.labels_json, []),
    args.addLabels,
    args.removeLabels,
  );
  await env.DB.prepare("UPDATE messages SET labels_json = ? WHERE id = ?")
    .bind(JSON.stringify(labels), message.id)
    .run();
  const updated = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
    .bind(message.id)
    .first<MessageRow>();
  if (!updated) throw new ApiError(404, "not_found", "Message not found");
  return messageJson(updated, mailbox.domain, false);
}

export async function getAttachment(
  env: Env,
  principal: Principal,
  args: { inboxId: string; threadId: string; attachmentId: string },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:read",
  );
  const row = await env.DB.prepare(
    "SELECT * FROM attachments WHERE id = ? AND thread_id = ? AND mailbox_id = ?",
  )
    .bind(args.attachmentId, args.threadId, mailbox.id)
    .first<{
      id: string;
      message_id: string;
      name: string;
      type: string;
      size: number;
      risk: string;
      r2_key: string;
    }>();
  if (!row) throw new ApiError(404, "not_found", "Attachment not found");
  const message = await env.DB.prepare(
    "SELECT visible_to_agent FROM messages WHERE id = ?",
  )
    .bind(row.message_id)
    .first<{ visible_to_agent: number }>();
  if (principal.class !== "owner" && message?.visible_to_agent !== 1)
    throw new ApiError(404, "not_found", "Attachment not found");
  const exp = Date.now() + 15 * 60 * 1000;
  const { hmacHex } = await import("./crypto");
  const sig = (await hmacHex(env.TOKEN_PEPPER, `${row.id}.${exp}`)).slice(
    0,
    32,
  );
  const path = `/v1/attachments/${row.id}/download?exp=${exp}&sig=${sig}`;
  const downloadUrl =
    row.risk === "high" ? undefined : `${env.PUBLIC_BASE_URL}${path}`;
  let extractedText: string | undefined;
  if (
    row.risk !== "high" &&
    (row.type.startsWith("text/") || row.type === "application/json")
  ) {
    const object = await env.ATTACHMENTS.get(row.r2_key);
    extractedText = object ? await object.text() : undefined;
  }
  return {
    attachmentId: row.id,
    filename: row.name,
    contentType: row.type,
    size: row.size,
    risk: row.risk,
    downloadUrl,
    expiresAt: new Date(exp).toISOString(),
    extractedText,
    untrusted: true,
    source: "email",
  };
}

export async function createDraft(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:draft",
  );
  if (args.clientId) {
    const existing = await env.DB.prepare(
      "SELECT * FROM drafts WHERE mailbox_id = ? AND client_id = ?",
    )
      .bind(mailbox.id, String(args.clientId))
      .first<DraftRow>();
    if (existing) return draftJson(existing);
  }
  await consume(
    env,
    mailbox.id,
    "draft-hour",
    LIMITS.draftsPerHour,
    LIMITS.hourMs,
  );
  const recipients = recipientsOf(args, true);
  rejectBcc(args);
  const attachments = await saveAttachments(env, mailbox.id, args.attachments);
  const ts = nowIso();
  const id = newId("drf");
  let threadId: string | null = null;
  let inReplyTo: string | null = null;
  if (typeof args.inReplyTo === "string" && args.inReplyTo) {
    const parent = await requireMessage(env, mailbox, args.inReplyTo, false);
    threadId = parent.thread_id;
    inReplyTo = publicMessageId(parent, mailbox.domain);
  }
  await env.DB.prepare(
    `INSERT INTO drafts (
      id, mailbox_id, thread_id, to_json, cc_json, subject, text, html, attachments_json, labels_json, state,
      in_reply_to, refs_json, created_by, client_id, send_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, '[]', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      mailbox.id,
      threadId,
      JSON.stringify(recipients.to),
      JSON.stringify(recipients.cc),
      stripCrlf(String(args.subject ?? "")),
      String(args.text ?? ""),
      typeof args.html === "string" ? args.html : null,
      JSON.stringify(attachments),
      JSON.stringify(asStrings(args.labels)),
      inReplyTo,
      principal.tokenId,
      typeof args.clientId === "string" ? args.clientId : null,
      typeof args.sendAt === "string" ? args.sendAt : null,
      ts,
      ts,
    )
    .run();
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "draft.create",
    mailboxId: mailbox.id,
    draftId: id,
    result: "ok",
  });
  const draft = await getDraftRow(env, mailbox.id, id);
  return draftJson(draft);
}

export async function listDrafts(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:draft",
  );
  const limit = clampLimit(args.limit);
  const offset = decodePage(
    typeof args.pageToken === "string" ? args.pageToken : undefined,
  );
  const result = await env.DB.prepare(
    "SELECT * FROM drafts WHERE mailbox_id = ? AND state != 'cancelled' ORDER BY updated_at DESC LIMIT ? OFFSET ?",
  )
    .bind(mailbox.id, limit, offset)
    .all<DraftRow>();
  const drafts = (result.results ?? []).map(draftJson);
  return page({ drafts }, drafts.length, limit, offset, offset + drafts.length);
}

export async function getDraft(
  env: Env,
  principal: Principal,
  args: { inboxId: string; draftId: string },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:draft",
  );
  return draftJson(await getDraftRow(env, mailbox.id, args.draftId));
}

export async function updateDraft(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:draft",
  );
  const draft = await getDraftRow(env, mailbox.id, String(args.draftId ?? ""));
  if (draft.state === "sent" || draft.state === "sending")
    throw new ApiError(409, "conflict", "Sent drafts cannot be edited");
  rejectBcc(args);
  const recipients = {
    to:
      args.to !== undefined
        ? recipientsOf(args, true).to
        : parseJson<string[]>(draft.to_json, []),
    cc:
      args.cc !== undefined
        ? recipientsOf({ ...args, to: args.to ?? [] }, true).cc
        : parseJson<string[]>(draft.cc_json, []),
  };
  if (args.to !== undefined || args.cc !== undefined) {
    const parsed = recipientsOf(
      {
        to: args.to ?? parseJson(draft.to_json, []),
        cc: args.cc ?? parseJson(draft.cc_json, []),
      },
      true,
    );
    recipients.to = parsed.to;
    recipients.cc = parsed.cc;
  }
  const text = args.text !== undefined ? String(args.text) : draft.text;
  const subject =
    args.subject !== undefined
      ? stripCrlf(String(args.subject))
      : draft.subject;
  const html =
    args.html !== undefined
      ? typeof args.html === "string"
        ? args.html
        : null
      : draft.html;
  const ts = nowIso();
  if (
    draft.review_id &&
    ["pending_approval", "approved"].includes(draft.state)
  ) {
    await env.DB.prepare(
      "UPDATE review_items SET state = 'cancelled', decision = 'edited' WHERE id = ?",
    )
      .bind(draft.review_id)
      .run();
  }
  await env.DB.prepare(
    `UPDATE drafts SET to_json = ?, cc_json = ?, subject = ?, text = ?, html = ?, state = 'draft', content_hash = NULL,
     review_id = NULL, send_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      JSON.stringify(recipients.to),
      JSON.stringify(recipients.cc),
      subject,
      text,
      html,
      typeof args.sendAt === "string" ? args.sendAt : draft.send_at,
      ts,
      draft.id,
    )
    .run();
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "draft.update",
    mailboxId: mailbox.id,
    draftId: draft.id,
    result: "ok",
    detail: { resetApproval: true },
  });
  return draftJson(await getDraftRow(env, mailbox.id, draft.id));
}

export async function deleteDraft(
  env: Env,
  principal: Principal,
  args: { inboxId: string; draftId: string },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:draft",
  );
  const draft = await getDraftRow(env, mailbox.id, args.draftId);
  await env.DB.prepare(
    "UPDATE drafts SET state = 'cancelled', updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), draft.id)
    .run();
  if (draft.review_id)
    await env.DB.prepare(
      "UPDATE review_items SET state = 'cancelled' WHERE id = ?",
    )
      .bind(draft.review_id)
      .run();
  return { success: true as const };
}

export async function sendDraft(
  env: Env,
  principal: Principal,
  args: { inboxId: string; draftId: string },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:request-send",
  );
  const draft = await getDraftRow(env, mailbox.id, args.draftId);
  return requestSend(env, principal, mailbox, draft);
}

export async function sendMessage(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const draft = await createDraft(env, principal, args);
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:request-send",
  );
  const row = await getDraftRow(env, mailbox.id, String(draft.draftId));
  return requestSend(env, principal, mailbox, row);
}

export async function replyToMessage(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:draft",
  );
  const message = await requireMessage(
    env,
    mailbox,
    String(args.messageId ?? ""),
    principal.class !== "owner",
  );
  if (args.replyAll === true && (args.to || args.cc || args.bcc)) {
    throw new ApiError(
      400,
      "invalid",
      "replyAll cannot be combined with recipients",
    );
  }
  rejectBcc(args);
  const to = args.replyAll === true ? [message.from_addr] : asStrings(args.to);
  const cc =
    args.replyAll === true
      ? unique([
          ...parseJson<string[]>(message.to_json, []),
          ...parseJson<string[]>(message.cc_json, []),
        ]).filter(
          (address) =>
            address !== mailbox.address && address !== message.from_addr,
        )
      : asStrings(args.cc);
  const recipients =
    to.length > 0
      ? to
      : [
          message.from_addr === mailbox.address
            ? parseJson<string[]>(message.to_json, [])[0]
            : message.from_addr,
        ].filter((item): item is string => Boolean(item));
  const subject = message.subject.toLowerCase().startsWith("re:")
    ? message.subject
    : `Re: ${message.subject}`;
  const quoted = message.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const text = `${String(args.text ?? "")}\n\nOn ${message.received_at}, ${message.from_addr} wrote:\n${quoted}`;
  return sendMessage(env, principal, {
    inboxId: mailbox.address,
    to: recipients,
    cc,
    subject,
    text,
    html: args.html,
    attachments: args.attachments,
    labels: args.labels,
    inReplyTo: publicMessageId(message, mailbox.domain),
  });
}

export async function forwardMessage(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    String(args.inboxId ?? ""),
    "mail:read",
  );
  const message = await requireMessage(
    env,
    mailbox,
    String(args.messageId ?? ""),
    principal.class !== "owner",
  );
  const subject =
    typeof args.subject === "string" && args.subject
      ? args.subject
      : `Fwd: ${message.subject}`;
  const text = `${String(args.text ?? "")}\n\n---------- Forwarded message ----------\nFrom: ${message.from_addr}\nSubject: ${message.subject}\n\n${message.text}`;
  return sendMessage(env, principal, {
    inboxId: mailbox.address,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject,
    text,
    html: args.html,
    attachments: args.attachments,
    labels: args.labels,
    inReplyTo: publicMessageId(message, mailbox.domain),
  });
}

export async function listListEntries(
  env: Env,
  principal: Principal,
  args: {
    inboxId: string;
    direction: string;
    listType: string;
    limit?: number;
    pageToken?: string;
  },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:read",
  );
  assertListShape(args.direction, args.listType);
  const limit = clampLimit(args.limit);
  const offset = decodePage(args.pageToken);
  const result = await env.DB.prepare(
    "SELECT * FROM list_entries WHERE mailbox_id = ? AND direction = ? AND list_type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
  )
    .bind(mailbox.id, args.direction, args.listType, limit, offset)
    .all<{
      id: string;
      entry: string;
      reason: string | null;
      created_at: string;
    }>();
  const entries = (result.results ?? []).map((row) => ({
    entry: row.entry,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  }));
  return page(
    { entries },
    entries.length,
    limit,
    offset,
    offset + entries.length,
  );
}

export async function createListEntry(
  env: Env,
  principal: Principal,
  args: {
    inboxId: string;
    direction: string;
    listType: string;
    entry: string;
    reason?: string;
  },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:write",
  );
  assertListShape(args.direction, args.listType);
  const widens = args.listType === "allow";
  if (widens && principal.class !== "owner")
    throw new ApiError(403, "forbidden", "Allow-list changes are owner-only");
  const entry = args.entry.trim().toLowerCase();
  if (!entry || entry.includes(" "))
    throw new ApiError(400, "invalid", "Invalid list entry");
  const id = newId("lst");
  await env.DB.prepare(
    "INSERT INTO list_entries (id, mailbox_id, direction, list_type, entry, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mailbox_id, direction, list_type, entry) DO NOTHING",
  )
    .bind(
      id,
      mailbox.id,
      args.direction,
      args.listType,
      entry,
      args.reason ?? null,
      principal.tokenId,
      nowIso(),
    )
    .run();
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "list.create",
    mailboxId: mailbox.id,
    result: "ok",
    detail: { direction: args.direction, listType: args.listType },
  });
  return { success: true as const, entry };
}

export async function deleteListEntry(
  env: Env,
  principal: Principal,
  args: { inboxId: string; direction: string; listType: string; entry: string },
) {
  const mailbox = await requireMailbox(
    env,
    principal,
    args.inboxId,
    "mail:write",
  );
  if (args.listType === "allow" && principal.class !== "owner")
    throw new ApiError(403, "forbidden", "Allow-list changes are owner-only");
  await env.DB.prepare(
    "DELETE FROM list_entries WHERE mailbox_id = ? AND direction = ? AND list_type = ? AND entry = ?",
  )
    .bind(mailbox.id, args.direction, args.listType, args.entry.toLowerCase())
    .run();
  return { success: true as const };
}

export async function listEvents(
  env: Env,
  principal: Principal,
  args: { since?: string; limit?: number },
) {
  const limit = clampLimit(args.limit, 20, 100);
  const rows = await listMailboxes(env);
  const ids = rows
    .filter((row) => canSee(principal, row.address))
    .map((row) => row.id);
  if (ids.length === 0) return { events: [] };
  const placeholders = ids.map(() => "?").join(", ");
  const since = args.since ?? "1970-01-01T00:00:00.000Z";
  const result = await env.DB.prepare(
    `SELECT * FROM wake_events WHERE mailbox_id IN (${placeholders}) AND created_at > ? ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(...ids, since, limit)
    .all<{
      id: string;
      mailbox_id: string;
      thread_id: string | null;
      message_id: string | null;
      sender: string | null;
      trust: string | null;
      received_at: string | null;
      created_at: string;
    }>();
  return {
    events: (result.results ?? []).map((row) => ({
      id: row.id,
      mailboxId: row.mailbox_id,
      threadId: row.thread_id,
      messageId: row.message_id,
      sender: row.sender,
      trust: row.trust,
      receivedAt: row.received_at,
      createdAt: row.created_at,
    })),
  };
}

export async function systemSend(
  env: Env,
  principal: Principal,
  args: { kind?: string; to?: string; variables?: Record<string, string> },
) {
  const kind = String(args.kind ?? "");
  if (!isTemplateKind(kind))
    throw new ApiError(400, "invalid", "Unknown template");
  assertScope(principal, `system:send:${kind}`);
  const recipient = parseAddress(String(args.to ?? ""));
  if (!recipient || !isOwnerAddress(env, recipient.email)) {
    throw new ApiError(
      403,
      "forbidden",
      "System mail can only go to an allow-listed owner address",
    );
  }
  let rendered: { subject: string; text: string };
  try {
    rendered = renderTemplate(kind as TemplateKind, args.variables ?? {});
  } catch (error) {
    throw new ApiError(
      400,
      "invalid",
      error instanceof Error ? error.message : "Invalid template variables",
    );
  }
  const suppressed = await env.DB.prepare(
    "SELECT email FROM suppressions WHERE email = ?",
  )
    .bind(recipient.email)
    .first();
  if (suppressed)
    throw new ApiError(409, "conflict", "Recipient is suppressed");
  if ((await getSetting(env, "global_freeze")) === "1")
    throw new ApiError(423, "frozen", "Sending is frozen");
  const rate = await globalStub(env).consume(
    `otp:${recipient.email}`,
    LIMITS.otpPerHour,
    LIMITS.hourMs,
  );
  if (!rate.ok)
    throw new ApiError(429, "rate_limited", "System mail rate limit", {
      retryAfterSec: rate.retryAfterSec,
    });
  const payload = buildSendPayload({
    from: env.SYSTEM_FROM,
    to: [recipient.email],
    subject: rendered.subject,
    text: rendered.text,
    autoSubmitted: true,
  });
  const result = await globalStub(env).deliver({
    frozen: false,
    globalFrozen: false,
    paused: false,
    payload,
    perDay: LIMITS.sendsPerDayGlobal,
    globalPerDay: LIMITS.sendsPerDayGlobal,
    checkGlobal: true,
  });
  if (!result.ok)
    throw new ApiError(
      result.code === "frozen" ? 423 : 429,
      result.code,
      "System mail was not sent",
      { retryAfterSec: result.retryAfterSec },
    );
  await recordAttempt(env, null, null, result.messageId, payload);
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "system.send",
    result: "ok",
    detail: { kind },
    contentHash: await contentHash({
      from: payload.from,
      to: payload.to,
      cc: [],
      subject: payload.subject,
      text: payload.text,
      html: "",
      attachmentHashes: [],
      threadId: null,
    }),
  });
  return { status: "sent" as const, messageId: result.messageId };
}

export async function approveReview(
  env: Env,
  principal: Principal,
  reviewId: string,
  args: {
    contentHash?: string;
    acknowledgeSecrets?: boolean;
    raiseCap?: boolean;
    via?: string;
  },
) {
  assertScope(principal, "admin");
  const review = await env.DB.prepare("SELECT * FROM review_items WHERE id = ?")
    .bind(reviewId)
    .first<ReviewRow>();
  if (review?.direction !== "outbound" || !review?.draft_id)
    throw new ApiError(404, "not_found", "Review item not found");
  if (review.state !== "pending")
    throw new ApiError(409, "conflict", `Review is ${review.state}`);
  if (review.expires_at && review.expires_at < nowIso()) {
    await env.DB.prepare(
      "UPDATE review_items SET state = 'expired' WHERE id = ?",
    )
      .bind(review.id)
      .run();
    throw new ApiError(410, "expired", "Review expired");
  }
  const draft = await env.DB.prepare("SELECT * FROM drafts WHERE id = ?")
    .bind(review.draft_id)
    .first<DraftRow>();
  if (!draft) throw new ApiError(404, "not_found", "Draft not found");
  const mailbox = await findMailbox(env, draft.mailbox_id);
  if (!mailbox) throw new ApiError(404, "not_found", "Inbox not found");
  const recomputed = await hashDraft(env, mailbox, draft);
  if (
    !args.contentHash ||
    args.contentHash !== draft.content_hash ||
    args.contentHash !== recomputed
  ) {
    throw new ApiError(
      409,
      "conflict",
      "Approval does not match the draft content",
    );
  }
  const reasons = parseJson<string[]>(draft.reason_codes_json, []);
  if (reasons.includes("secret_pattern") && args.acknowledgeSecrets !== true) {
    throw new ApiError(
      409,
      "conflict",
      "Secret-like content needs an explicit acknowledgement",
    );
  }
  const to = parseJson<string[]>(draft.to_json, []);
  const cc = parseJson<string[]>(draft.cc_json, []);
  for (const email of [...to, ...cc]) {
    const suppressed = await env.DB.prepare(
      "SELECT email FROM suppressions WHERE email = ?",
    )
      .bind(email)
      .first();
    if (suppressed)
      throw new ApiError(409, "conflict", "Recipient is suppressed");
  }
  const globalFrozen = (await getSetting(env, "global_freeze")) === "1";
  if (args.raiseCap)
    await boxStub(env, mailbox.id).addAllowance("sends-day", 10);
  const sent = await executeSend(env, mailbox, draft, { globalFrozen, to, cc });
  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE drafts SET state = 'sent', provider_message_id = ?, updated_at = ? WHERE id = ?",
    ).bind(sent.messageId, ts, draft.id),
    env.DB.prepare(
      "UPDATE review_items SET state = 'approved', decision = 'approved', decided_by = ?, decided_at = ?, via = ? WHERE id = ?",
    ).bind(principal.label, ts, args.via ?? "api", review.id),
    env.DB.prepare(
      "INSERT INTO approvals (id, draft_id, content_hash, decision, decided_by, decided_at, via) VALUES (?, ?, ?, 'approved', ?, ?, ?)",
    ).bind(
      newId("apr"),
      draft.id,
      recomputed,
      principal.label,
      ts,
      args.via ?? "api",
    ),
  ]);
  await audit(env, {
    actorType: "owner",
    tokenId: principal.tokenId,
    action: "review.approve",
    mailboxId: mailbox.id,
    draftId: draft.id,
    contentHash: recomputed,
    decision: "approved",
    result: "ok",
  });
  return {
    status: "sent" as const,
    messageId: sent.messageId,
    contentHash: recomputed,
  };
}

export async function rejectReview(
  env: Env,
  principal: Principal,
  reviewId: string,
  note?: string,
) {
  assertScope(principal, "admin");
  const review = await env.DB.prepare("SELECT * FROM review_items WHERE id = ?")
    .bind(reviewId)
    .first<ReviewRow>();
  if (!review) throw new ApiError(404, "not_found", "Review item not found");
  const ts = nowIso();
  await env.DB.prepare(
    "UPDATE review_items SET state = 'rejected', decision = 'rejected', note = ?, decided_by = ?, decided_at = ?, via = 'api' WHERE id = ?",
  )
    .bind(note ?? null, principal.label, ts, review.id)
    .run();
  if (review.draft_id)
    await env.DB.prepare(
      "UPDATE drafts SET state = 'rejected', updated_at = ? WHERE id = ?",
    )
      .bind(ts, review.draft_id)
      .run();
  await audit(env, {
    actorType: "owner",
    tokenId: principal.tokenId,
    action: "review.reject",
    mailboxId: review.mailbox_id,
    draftId: review.draft_id,
    decision: "rejected",
    result: "ok",
  });
  return { status: "rejected" as const };
}

export async function releaseQuarantine(
  env: Env,
  principal: Principal,
  reviewId: string,
) {
  assertScope(principal, "admin");
  const review = await env.DB.prepare("SELECT * FROM review_items WHERE id = ?")
    .bind(reviewId)
    .first<ReviewRow>();
  if (review?.direction !== "inbound" || !review?.message_id)
    throw new ApiError(404, "not_found", "Quarantine item not found");
  const message = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
    .bind(review.message_id)
    .first<MessageRow>();
  if (!message) throw new ApiError(404, "not_found", "Message not found");
  const labels = mergeLabels(
    parseJson<string[]>(message.labels_json, []),
    [],
    ["quarantine", "spam"],
  );
  await env.DB.prepare(
    "UPDATE messages SET visible_to_agent = 1, labels_json = ? WHERE id = ?",
  )
    .bind(JSON.stringify(labels), message.id)
    .run();
  await env.DB.prepare(
    "UPDATE review_items SET state = 'released', decision = 'released', decided_by = ?, decided_at = ?, via = 'api' WHERE id = ?",
  )
    .bind(principal.label, nowIso(), review.id)
    .run();
  const mailbox = await findMailbox(env, message.mailbox_id);
  if (mailbox && message.auto === 0) {
    await enqueueWake(env, {
      mailboxId: mailbox.id,
      threadId: message.thread_id,
      messageId: message.id,
      sender: message.from_addr,
      trust: message.trust,
      receivedAt: message.received_at,
      wakeUrl: mailbox.wake_url,
    });
  }
  await audit(env, {
    actorType: "owner",
    tokenId: principal.tokenId,
    action: "quarantine.release",
    mailboxId: message.mailbox_id,
    messageId: message.id,
    result: "ok",
  });
  return { status: "released" as const };
}

export async function setGlobalFreeze(
  env: Env,
  principal: Principal,
  frozen: boolean,
) {
  assertScope(principal, "admin");
  await setSetting(env, "global_freeze", frozen ? "1" : "0");
  await globalStub(env).setFrozen(frozen);
  await audit(env, {
    actorType: "owner",
    tokenId: principal.tokenId,
    action: frozen ? "freeze" : "unfreeze",
    result: "ok",
  });
  return { frozen };
}

export async function setMailboxFreeze(
  env: Env,
  principal: Principal,
  inboxId: string,
  frozen: boolean,
) {
  assertScope(principal, "admin");
  const mailbox = await requireMailbox(env, principal, inboxId, "admin");
  await env.DB.prepare(
    "UPDATE mailboxes SET frozen = ?, updated_at = ? WHERE id = ?",
  )
    .bind(frozen ? 1 : 0, nowIso(), mailbox.id)
    .run();
  await boxStub(env, mailbox.id).setFrozen(frozen);
  await audit(env, {
    actorType: "owner",
    tokenId: principal.tokenId,
    action: frozen ? "mailbox.freeze" : "mailbox.unfreeze",
    mailboxId: mailbox.id,
    result: "ok",
  });
  return { frozen, inboxId: mailbox.address };
}

export async function ownerSearch(env: Env, principal: Principal, q: string) {
  assertScope(principal, "admin");
  const match = ftsQuery(q);
  if (!match) return [];
  const ids = await searchIds(env, match, null, false);
  const messages = [];
  for (const id of ids) {
    const message = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
      .bind(id)
      .first<MessageRow>();
    if (message) messages.push(message);
  }
  return messages;
}

async function requestSend(
  env: Env,
  principal: Principal,
  mailbox: MailboxRow,
  draft: DraftRow,
) {
  if (
    draft.state === "pending_approval" &&
    draft.review_id &&
    draft.content_hash
  ) {
    return {
      status: "pending_review" as const,
      reviewId: draft.review_id,
      draftId: draft.id,
      contentHash: draft.content_hash,
      threadId: draft.thread_id,
      reasonCodes: parseJson<string[]>(draft.reason_codes_json, []),
    };
  }
  if (draft.state === "sent")
    throw new ApiError(409, "conflict", "Draft was already sent");
  await consume(
    env,
    mailbox.id,
    "request-hour",
    LIMITS.requestSendPerHour,
    LIMITS.hourMs,
  );
  await consume(
    env,
    mailbox.id,
    "request-day",
    LIMITS.requestSendPerDay,
    LIMITS.dayMs,
  );
  const to = parseJson<string[]>(draft.to_json, []);
  const cc = parseJson<string[]>(draft.cc_json, []);
  if (to.length + cc.length === 0)
    throw new ApiError(400, "invalid", "A recipient is required");
  const text = withOutboundFooter(draft.text);
  const secrets = scanSecrets(`${draft.subject}\n${text}\n${draft.html ?? ""}`);
  const hosts = extractHosts(`${text}\n${draft.html ?? ""}`);
  const newLink = hosts.some((host) => !sameOrgHost(host, env.MAIL_DOMAIN));
  const attachments = parseJson<{ sha256: string; risk: string }[]>(
    draft.attachments_json,
    [],
  );
  const known = await Promise.all(
    [...to, ...cc].map((email) => recipientKnown(env, mailbox.id, email)),
  );
  const mode = normalizePolicyMode(mailbox.policy_mode);
  const decision = reviewDecision({
    mode,
    enforceKnownAuto: asString(env.ENFORCE_KNOWN_AUTO) === "true",
    systemTemplate: false,
    ownerRecipient: [...to, ...cc].every((email) => isOwnerAddress(env, email)),
    thirdParty: true,
    knownRecipient: known.every(Boolean),
    flagged:
      secrets.length > 0 ||
      newLink ||
      attachments.some((item) => item.risk === "high"),
    overLimit: false,
    inThread: Boolean(draft.thread_id),
  });
  const reasons = [...decision.reasons];
  if (secrets.length > 0) reasons.push("secret_pattern");
  if (newLink) reasons.push("new_link_host");
  if (!known.every(Boolean)) reasons.push("first_contact");
  if (decision.action === "deny")
    throw new ApiError(
      403,
      "forbidden",
      "This mailbox can only send owner templates",
    );
  const hash = await hashParts(env, mailbox, { ...draft, text, to, cc });
  if (decision.action === "send") {
    const sent = await executeSend(
      env,
      mailbox,
      { ...draft, text, content_hash: hash },
      {
        globalFrozen: (await getSetting(env, "global_freeze")) === "1",
        to,
        cc,
      },
    );
    await env.DB.prepare(
      "UPDATE drafts SET text = ?, state = 'sent', content_hash = ?, provider_message_id = ?, updated_at = ? WHERE id = ?",
    )
      .bind(text, hash, sent.messageId, nowIso(), draft.id)
      .run();
    return {
      status: "sent" as const,
      messageId: sent.messageId,
      draftId: draft.id,
      contentHash: hash,
    };
  }
  const reviewId = newId("rev");
  const ts = nowIso();
  const expires = new Date(Date.now() + LIMITS.reviewTtlMs).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO review_items (
        id, direction, mailbox_id, thread_id, draft_id, subject, state, reason_codes_json, content_hash, created_at, expires_at
      ) VALUES (?, 'outbound', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).bind(
      reviewId,
      mailbox.id,
      draft.thread_id,
      draft.id,
      draft.subject,
      JSON.stringify(reasons),
      hash,
      ts,
      expires,
    ),
    env.DB.prepare(
      "UPDATE drafts SET text = ?, state = 'pending_approval', content_hash = ?, review_id = ?, reason_codes_json = ?, expires_at = ?, updated_at = ? WHERE id = ?",
    ).bind(
      text,
      hash,
      reviewId,
      JSON.stringify(reasons),
      expires,
      ts,
      draft.id,
    ),
  ]);
  await audit(env, {
    actorType: principal.class,
    tokenId: principal.tokenId,
    action: "draft.request_send",
    mailboxId: mailbox.id,
    draftId: draft.id,
    contentHash: hash,
    result: "pending_review",
    detail: { reasons },
  });
  return {
    status: "pending_review" as const,
    reviewId,
    draftId: draft.id,
    contentHash: hash,
    threadId: draft.thread_id,
    reasonCodes: reasons,
  };
}

async function executeSend(
  env: Env,
  mailbox: MailboxRow,
  draft: DraftRow,
  input: { globalFrozen: boolean; to: string[]; cc: string[] },
): Promise<{ messageId: string }> {
  const replyTo = await signedReplyTo(env, mailbox, draft.thread_id);
  const external: string[] = [];
  const local: MailboxRow[] = [];
  for (const email of input.to) {
    const box = await findMailbox(env, email);
    if (box && box.enabled === 1 && box.domain === env.MAIL_DOMAIN)
      local.push(box);
    else external.push(email);
  }
  let messageId = `local_${crypto.randomUUID()}`;
  if (external.length > 0) {
    const payload = buildSendPayload({
      from: mailbox.address,
      to: external,
      cc: input.cc,
      subject: draft.subject,
      text: draft.text,
      html: draft.html ?? undefined,
      replyTo,
      inReplyTo: draft.in_reply_to ?? undefined,
      references: parseJson<string[]>(draft.refs_json, []),
    });
    const global = await globalStub(env).consume(
      "sends-global",
      LIMITS.sendsPerDayGlobal,
      LIMITS.dayMs,
    );
    if (!global.ok)
      throw new ApiError(429, "rate_limited", "Global send rate limit", {
        retryAfterSec: global.retryAfterSec,
      });
    const result = await boxStub(env, mailbox.id).deliver({
      frozen: mailbox.frozen === 1,
      globalFrozen: input.globalFrozen,
      paused: mailbox.outbound_paused === 1,
      payload,
      perDay: LIMITS.sendsPerDayMailbox,
      globalPerDay: LIMITS.sendsPerDayGlobal,
      checkGlobal: false,
    });
    if (!result.ok) {
      const status =
        result.code === "frozen" || result.code === "paused"
          ? 423
          : result.code === "rate_limited"
            ? 429
            : 409;
      throw new ApiError(status, result.code, "Send was not accepted", {
        retryAfterSec: result.retryAfterSec,
      });
    }
    messageId = result.messageId;
    await recordAttempt(env, draft.id, mailbox.id, messageId, payload);
  }
  await storeOutboundCopy(env, mailbox, draft, messageId, input.to);
  for (const box of local) {
    await deliverInternal(env, box, mailbox, draft, messageId);
  }
  return { messageId };
}

async function storeOutboundCopy(
  env: Env,
  mailbox: MailboxRow,
  draft: DraftRow,
  providerId: string,
  to: string[],
) {
  const threadId = draft.thread_id ?? newId("thd");
  const ts = nowIso();
  const messageId = newId("msg");
  if (!draft.thread_id) {
    await env.DB.prepare(
      `INSERT INTO threads (id, mailbox_id, subject, subject_norm, labels_json, participants_json, preview, message_count, last_message_at, created_at)
       VALUES (?, ?, ?, ?, '["sent"]', ?, ?, 1, ?, ?)`,
    )
      .bind(
        threadId,
        mailbox.id,
        draft.subject,
        normalizeSubject(draft.subject),
        JSON.stringify([mailbox.address, ...to]),
        previewText(draft.text),
        ts,
        ts,
      )
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO messages (
      id, thread_id, mailbox_id, direction, origin, rfc_message_id, in_reply_to, refs_json, from_addr, to_json, cc_json,
      subject, text, size, auth_json, trust, auto, visible_to_agent, labels_json, preview, received_at, provider_message_id, draft_id
    ) VALUES (?, ?, ?, 'outbound', 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'agent', 0, 1, '["sent"]', ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      threadId,
      mailbox.id,
      providerId,
      draft.in_reply_to,
      draft.refs_json,
      mailbox.address,
      JSON.stringify(to),
      draft.cc_json,
      draft.subject,
      draft.text,
      draft.text.length,
      previewText(draft.text),
      ts,
      providerId,
      draft.id,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO messages_fts (message_id, mailbox_id, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      messageId,
      mailbox.id,
      draft.subject,
      mailbox.address,
      to.join(" "),
      draft.text,
    )
    .run();
}

async function deliverInternal(
  env: Env,
  mailbox: MailboxRow,
  from: MailboxRow,
  draft: DraftRow,
  providerId: string,
) {
  const threadId = newId("thd");
  const messageId = newId("msg");
  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO threads (id, mailbox_id, subject, subject_norm, labels_json, participants_json, preview, message_count, last_message_at, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, 1, ?, ?)`,
    ).bind(
      threadId,
      mailbox.id,
      draft.subject,
      normalizeSubject(draft.subject),
      JSON.stringify([from.address, mailbox.address]),
      previewText(draft.text),
      ts,
      ts,
    ),
    env.DB.prepare(
      `INSERT INTO messages (
        id, thread_id, mailbox_id, direction, origin, rfc_message_id, from_addr, to_json, cc_json, subject, text, size,
        auth_json, trust, auto, visible_to_agent, labels_json, preview, received_at, provider_message_id
      ) VALUES (?, ?, ?, 'inbound', 'agent', ?, ?, ?, '[]', ?, ?, ?, '{}', 'agent', 0, 1, '["unread"]', ?, ?, ?)`,
    ).bind(
      messageId,
      threadId,
      mailbox.id,
      providerId,
      from.address,
      JSON.stringify([mailbox.address]),
      draft.subject,
      draft.text,
      draft.text.length,
      previewText(draft.text),
      ts,
      providerId,
    ),
    env.DB.prepare(
      "INSERT INTO messages_fts (message_id, mailbox_id, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      messageId,
      mailbox.id,
      draft.subject,
      from.address,
      mailbox.address,
      draft.text,
    ),
  ]);
  if (mailbox.frozen === 0) {
    await enqueueWake(env, {
      mailboxId: mailbox.id,
      threadId,
      messageId,
      sender: from.address,
      trust: "agent",
      receivedAt: ts,
      wakeUrl: mailbox.wake_url,
    });
  }
}

async function signedReplyTo(
  env: Env,
  mailbox: MailboxRow,
  threadId: string | null,
): Promise<string> {
  if (!threadId) return mailbox.address;
  const tag = await signThreadTag(threadId, env.REPLY_HMAC_KEY);
  return `${mailbox.slug}+${tag}@${mailbox.domain}`;
}

async function hashDraft(
  env: Env,
  mailbox: MailboxRow,
  draft: DraftRow,
): Promise<string> {
  return hashParts(env, mailbox, {
    ...draft,
    to: parseJson<string[]>(draft.to_json, []),
    cc: parseJson<string[]>(draft.cc_json, []),
  });
}

async function hashParts(
  _env: Env,
  mailbox: MailboxRow,
  draft: {
    text: string;
    html: string | null;
    subject: string;
    thread_id: string | null;
    to: string[];
    cc: string[];
    attachments_json?: string;
  },
): Promise<string> {
  const attachments = parseJson<{ sha256: string }[]>(
    draft.attachments_json ?? "[]",
    [],
  );
  return contentHash({
    from: mailbox.address,
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    text: draft.text,
    html: draft.html ?? "",
    attachmentHashes: attachments.map((item) => item.sha256),
    threadId: draft.thread_id,
  });
}

async function recordAttempt(
  env: Env,
  draftId: string | null,
  mailboxId: string | null,
  providerId: string,
  payload: OutboundPayload,
) {
  await env.DB.prepare(
    "INSERT INTO outbound_attempts (id, draft_id, mailbox_id, provider_message_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      newId("out"),
      draftId,
      mailboxId,
      providerId,
      JSON.stringify(payload),
      nowIso(),
    )
    .run();
}

async function recipientKnown(
  env: Env,
  mailboxId: string,
  email: string,
): Promise<boolean> {
  const listed = await env.DB.prepare(
    "SELECT id FROM list_entries WHERE mailbox_id = ? AND direction = 'send' AND list_type = 'allow' AND entry = ? LIMIT 1",
  )
    .bind(mailboxId, email)
    .first();
  if (listed) return true;
  const prior = await env.DB.prepare(
    "SELECT id FROM messages WHERE mailbox_id = ? AND direction = 'outbound' AND instr(to_json, ?) > 0 LIMIT 1",
  )
    .bind(mailboxId, email)
    .first();
  return Boolean(prior);
}

async function consume(
  env: Env,
  mailboxId: string,
  bucket: string,
  limit: number,
  windowMs: number,
) {
  const result = await boxStub(env, mailboxId).consume(bucket, limit, windowMs);
  if (!result.ok)
    throw new ApiError(429, "rate_limited", "Rate limit", {
      retryAfterSec: result.retryAfterSec,
    });
}

async function saveAttachments(env: Env, mailboxId: string, value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new ApiError(400, "invalid", "Attachments must be a list");
  let total = 0;
  const saved = [];
  for (const item of value) {
    if (!item || typeof item !== "object")
      throw new ApiError(400, "invalid", "Bad attachment");
    const record = item as {
      filename?: string;
      contentType?: string;
      content?: string;
      url?: string;
    };
    if (record.url)
      throw new ApiError(400, "invalid", "Attachment URLs are not accepted");
    if (!record.content || !record.filename)
      throw new ApiError(
        400,
        "invalid",
        "Attachment needs filename and content",
      );
    const bytes = decodeBase64(record.content);
    total += bytes.byteLength;
    if (total > LIMITS.outboundMaxBytes)
      throw new ApiError(400, "invalid", "Attachments exceed 5 MiB");
    const type = record.contentType || "application/octet-stream";
    if (attachmentRisk(record.filename, type) === "high")
      throw new ApiError(400, "invalid", "That attachment type cannot be sent");
    const id = newId("att");
    const key = `draft-att/${mailboxId}/${id}`;
    await env.ATTACHMENTS.put(key, bytes);
    saved.push({
      id,
      name: record.filename,
      type,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      r2Key: key,
      risk: "low",
    });
  }
  return saved;
}

function recipientsOf(
  args: Record<string, unknown>,
  allowEmpty: boolean,
): { to: string[]; cc: string[] } {
  const to = addressList(args.to);
  const cc = addressList(args.cc);
  if (!to || !cc) throw new ApiError(400, "invalid", "Invalid recipient");
  if (!allowEmpty && to.length + cc.length === 0)
    throw new ApiError(400, "invalid", "A recipient is required");
  if (to.length + cc.length > LIMITS.maxRecipients)
    throw new ApiError(400, "invalid", "Too many recipients");
  return { to, cc };
}

function addressList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") return null;
    const parsed = parseAddress(item);
    if (!parsed) return null;
    out.push(parsed.email);
  }
  return out;
}

function rejectBcc(args: Record<string, unknown>) {
  const bcc = addressList(args.bcc);
  if (bcc && bcc.length > 0)
    throw new ApiError(400, "invalid", "BCC is not available");
}

function assertListShape(direction: string, listType: string) {
  if (
    !["send", "receive", "reply"].includes(direction) ||
    !["allow", "block"].includes(listType)
  ) {
    throw new ApiError(400, "invalid", "Unknown list");
  }
}

async function requireMailbox(
  env: Env,
  principal: Principal,
  inboxId: string,
  scope: string,
): Promise<MailboxRow> {
  const mailbox = await findMailbox(env, inboxId);
  if (!mailbox) throw new ApiError(404, "not_found", "Inbox not found");
  if (!hasScope(principal, "admin") && mailbox.enabled !== 1)
    throw new ApiError(404, "not_found", "Inbox not found");
  assertScope(principal, scope, mailbox.address);
  return mailbox;
}

function canSee(principal: Principal, address: string): boolean {
  return (
    hasScope(principal, "mail:read", address) || hasScope(principal, "admin")
  );
}

async function requireThread(
  env: Env,
  mailboxId: string,
  threadId: string,
): Promise<ThreadRow> {
  const thread = await env.DB.prepare(
    "SELECT * FROM threads WHERE id = ? AND mailbox_id = ?",
  )
    .bind(threadId, mailboxId)
    .first<ThreadRow>();
  if (!thread) throw new ApiError(404, "not_found", "Thread not found");
  return thread;
}

async function requireMessage(
  env: Env,
  mailbox: MailboxRow,
  messageId: string,
  agent: boolean,
): Promise<MessageRow> {
  const bare = messageId.replace(/[<>]/g, "");
  const message = await env.DB.prepare(
    `SELECT * FROM messages WHERE mailbox_id = ? AND (
      rfc_message_id = ? OR provider_message_id = ? OR id = ? OR rfc_message_id = ? OR id = ?
    ) LIMIT 1`,
  )
    .bind(mailbox.id, messageId, messageId, bare, `<${bare}>`, messageId)
    .first<MessageRow>();
  if (!message || (agent && message.visible_to_agent !== 1))
    throw new ApiError(404, "not_found", "Message not found");
  return message;
}

async function getDraftRow(
  env: Env,
  mailboxId: string,
  draftId: string,
): Promise<DraftRow> {
  const draft = await env.DB.prepare(
    "SELECT * FROM drafts WHERE id = ? AND mailbox_id = ?",
  )
    .bind(draftId, mailboxId)
    .first<DraftRow>();
  if (!draft || draft.state === "cancelled")
    throw new ApiError(404, "not_found", "Draft not found");
  return draft;
}

async function listThreadMessages(
  env: Env,
  threadId: string,
  agent: boolean,
  limit: number,
  offset: number,
): Promise<MessageRow[]> {
  const visible = agent ? "AND visible_to_agent = 1" : "";
  const result = await env.DB.prepare(
    `SELECT * FROM messages WHERE thread_id = ? ${visible} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(threadId, limit, offset)
    .all<MessageRow>();
  return result.results ?? [];
}

async function queryThreads(
  env: Env,
  _principal: Principal,
  mailbox: MailboxRow,
  args: Record<string, unknown>,
  _full: boolean,
) {
  const limit = clampLimit(args.limit);
  const offset = decodePage(
    typeof args.pageToken === "string" ? args.pageToken : undefined,
  );
  const where = ["mailbox_id = ?"];
  const binds: unknown[] = [mailbox.id];
  if (!args.includeTrash) where.push("instr(labels_json, '\"trash\"') = 0");
  if (!args.includeSpam) where.push("instr(labels_json, '\"spam\"') = 0");
  addLabelFilter(where, binds, args.labels);
  addTimeFilter(where, binds, args.before, args.after, "last_message_at");
  for (const value of asStrings(args.subject)) {
    where.push("instr(lower(subject), ?) > 0");
    binds.push(value.toLowerCase());
  }
  for (const value of [
    ...asStrings(args.senders),
    ...asStrings(args.recipients),
  ]) {
    where.push("instr(lower(participants_json), ?) > 0");
    binds.push(value.toLowerCase());
  }
  const order = args.ascending === true ? "ASC" : "DESC";
  const result = await env.DB.prepare(
    `SELECT * FROM threads WHERE ${where.join(" AND ")} ORDER BY last_message_at ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<ThreadRow>();
  const threads = [];
  for (const thread of result.results ?? [])
    threads.push(await threadJson(env, thread, false));
  return page(
    { threads },
    threads.length,
    limit,
    offset,
    offset + threads.length,
  );
}

async function searchIds(
  env: Env,
  match: string,
  mailboxId: string | null,
  agent: boolean,
): Promise<string[]> {
  const visible = agent ? "AND m.visible_to_agent = 1" : "";
  const mailbox = mailboxId ? "AND m.mailbox_id = ?" : "";
  const statement = env.DB.prepare(
    `SELECT m.id AS id FROM messages m
     WHERE m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)
     ${mailbox} ${visible}
     LIMIT 50`,
  );
  const result = mailboxId
    ? await statement.bind(match, mailboxId).all<{ id: string }>()
    : await statement.bind(match).all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}

function messageJson(message: MessageRow, domain: string, full = true) {
  const text = message.text;
  return {
    messageId: publicMessageId(message, domain),
    id: message.id,
    threadId: message.thread_id,
    inboxId: undefined as string | undefined,
    from: message.from_name
      ? `${message.from_name} <${message.from_addr}>`
      : message.from_addr,
    to: parseJson<string[]>(message.to_json, []),
    cc: parseJson<string[]>(message.cc_json, []),
    subject: message.subject,
    preview: message.preview ?? previewText(text),
    text: full ? text : undefined,
    extractedText: full ? text : undefined,
    labels: parseJson<string[]>(message.labels_json, []),
    timestamp: message.received_at,
    direction: message.direction,
    untrusted: true,
    source: "email",
    trust: message.trust,
    auth: parseJson(message.auth_json, {}),
    auto: message.auto === 1,
  };
}

async function threadJson(env: Env, thread: ThreadRow, _full: boolean) {
  const mailbox = await findMailbox(env, thread.mailbox_id);
  return {
    threadId: thread.id,
    inboxId: mailbox?.address,
    subject: thread.subject,
    preview: thread.preview ?? "",
    labels: parseJson<string[]>(thread.labels_json, []),
    senders: parseJson<string[]>(thread.participants_json, []),
    messageCount: thread.message_count,
    lastMessageAt: thread.last_message_at,
    timestamp: thread.last_message_at,
    untrusted: true,
    source: "email",
  };
}

function draftJson(draft: DraftRow) {
  return {
    draftId: draft.id,
    inboxId: undefined,
    threadId: draft.thread_id,
    to: parseJson<string[]>(draft.to_json, []),
    cc: parseJson<string[]>(draft.cc_json, []),
    subject: draft.subject,
    text: draft.text,
    html: draft.html,
    labels: parseJson<string[]>(draft.labels_json, []),
    state: draft.state,
    contentHash: draft.content_hash,
    reviewId: draft.review_id,
    sendAt: draft.send_at,
    createdAt: draft.created_at,
    updatedAt: draft.updated_at,
  };
}

function publicMessageId(message: MessageRow, domain: string): string {
  if (message.rfc_message_id) return message.rfc_message_id;
  if (message.provider_message_id) return message.provider_message_id;
  return `<${message.id}@${domain}>`;
}

function page<T extends Record<string, unknown>>(
  body: T,
  count: number,
  limit: number,
  offset: number,
  total: number,
) {
  return {
    count,
    limit,
    nextPageToken:
      offset + count < total ? encodePage(offset + count) : undefined,
    ...body,
  };
}

function addLabelFilter(where: string[], binds: unknown[], labels: unknown) {
  for (const label of asStrings(labels)) {
    where.push("instr(labels_json, ?) > 0");
    binds.push(`"${label}"`);
  }
}

function addTimeFilter(
  where: string[],
  binds: unknown[],
  before: unknown,
  after: unknown,
  column: string,
) {
  if (typeof before === "string" && before) {
    where.push(`${column} < ?`);
    binds.push(before);
  }
  if (typeof after === "string" && after) {
    where.push(`${column} >= ?`);
    binds.push(after);
  }
}

function asStrings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function mergeLabels(
  current: string[],
  add: string[] | undefined,
  remove: string[] | undefined,
): string[] {
  const next = new Set(current);
  for (const label of add ?? []) next.add(label);
  for (const label of remove ?? []) next.delete(label);
  return [...next];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
