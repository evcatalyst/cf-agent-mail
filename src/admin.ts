import { assertCsrf, csrfToken, ownerFromRequest } from "./authz";
import { hashToken, randomToken } from "./crypto";
import { ApiError } from "./errors";
import { escapeHtml, html, readBody } from "./http";
import { newId, nowIso, parseJson } from "./ids";
import {
  approveReview,
  ownerSearch,
  rejectReview,
  releaseQuarantine,
  setGlobalFreeze,
  setMailboxFreeze,
} from "./actions";
import {
  getSetting,
  listMailboxes,
  type MessageRow,
  type Principal,
  type ReviewRow,
} from "./store";

const CSS = `
:root { color-scheme: light; --ink: #1c1915; --paper: #f6f1e7; --line: #d9d0c1; --warn: #8a3b12; --ok: #1f6b45; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.45 "Iowan Old Style", Palatino, Georgia, serif; color: var(--ink); background: var(--paper); }
header, main { width: min(980px, calc(100% - 32px)); margin: 0 auto; }
header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; padding: 20px 0 8px; }
nav { display: flex; flex-wrap: wrap; gap: 12px; padding-bottom: 16px; }
a { color: var(--ink); }
table { width: 100%; border-collapse: collapse; background: white; }
th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 8px; vertical-align: top; font-size: 14px; }
.banner { background: #fff4d6; border: 1px solid #e0c36a; padding: 12px; margin: 12px 0; }
.warn { color: var(--warn); }
button, input, textarea, select { font: inherit; }
button { background: var(--ink); color: var(--paper); border: 0; padding: 6px 10px; cursor: pointer; }
button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--ink); }
textarea, input[type="text"], input[type="search"], input[type="password"], input[type="number"] { width: 100%; padding: 8px; border: 1px solid var(--line); background: white; }
pre { white-space: pre-wrap; font: 14px/1.4 ui-monospace, monospace; background: white; padding: 12px; border: 1px solid var(--line); }
form.inline { display: inline; }
`;

export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/admin/session" && request.method === "POST")
    return createSession(request, env);
  if (url.pathname === "/admin/logout" && request.method === "POST") {
    return html(page("Signed out", "<p>Signed out.</p>"), 200, {
      "set-cookie": "cfam_owner=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict",
    });
  }
  let principal: Principal;
  try {
    principal = await ownerFromRequest(request, env);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return loginPage(
        env,
        error.status === 403 ? error.message : "Sign in required.",
      );
    }
    throw error;
  }
  const path = url.pathname;
  if (path === "/admin" || path === "/admin/") return overview(env, principal);
  if (path === "/admin/mailboxes") return mailboxes(request, env, principal);
  if (path === "/admin/search") return searchPage(env, principal, url);
  if (path.startsWith("/admin/threads/"))
    return threadPage(
      env,
      principal,
      decodeURIComponent(path.slice("/admin/threads/".length)),
    );
  if (path === "/admin/review") return reviewPage(request, env, principal);
  if (path === "/admin/audit") return auditPage(env, principal, false);
  if (path === "/admin/audit.csv") return auditPage(env, principal, true);
  if (path === "/admin/tokens") return tokensPage(request, env, principal);
  if (path === "/admin/retention")
    return retentionPage(request, env, principal);
  if (path.startsWith("/admin/messages/") && path.endsWith("/raw")) {
    const id = decodeURIComponent(
      path.slice("/admin/messages/".length, -"/raw".length),
    );
    return rawMessage(env, id);
  }
  return html(page("Not found", "<p>That page does not exist.</p>"), 404);
}

async function overview(env: Env, principal: Principal): Promise<Response> {
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM review_items WHERE state = 'pending'",
  ).first<{ n: number }>();
  const sends = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM outbound_attempts WHERE created_at >= ?",
  )
    .bind(new Date(Date.now() - 86_400_000).toISOString())
    .first<{ n: number }>();
  const complaints = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM message_events WHERE type LIKE '%complain%'",
  ).first<{ n: number }>();
  const frozen = (await getSetting(env, "global_freeze")) === "1";
  const retention = (await getSetting(env, "last_retention_at")) ?? "never";
  const csrf = await csrfToken(env);
  const body = `
    <p>Pending review: <strong>${pending?.n ?? 0}</strong>. Sends in the last day: <strong>${sends?.n ?? 0}</strong>. Complaints recorded: <strong>${complaints?.n ?? 0}</strong>.</p>
    <p>Kill switch: <strong class="${frozen ? "warn" : ""}">${frozen ? "FROZEN" : "open"}</strong>. Last retention run: ${escapeHtml(retention)}.</p>
    <form method="post" action="/admin/mailboxes">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="global-freeze">
      <input type="hidden" name="frozen" value="${frozen ? "0" : "1"}">
      <button>${frozen ? "Unfreeze sending" : "Freeze all sending"}</button>
    </form>
    <p>Signed in as ${escapeHtml(principal.label)}.</p>`;
  return html(page("Overview", body));
}

async function mailboxes(
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  if (request.method === "POST") {
    const body = await readBody(request);
    await assertCsrf(request, env, String(body.csrf ?? ""));
    if (body.action === "global-freeze")
      await setGlobalFreeze(env, principal, body.frozen === "1");
    if (body.action === "freeze" && typeof body.inboxId === "string")
      await setMailboxFreeze(env, principal, body.inboxId, body.frozen === "1");
    return Response.redirect(
      new URL("/admin/mailboxes", request.url).toString(),
      303,
    );
  }
  const csrf = await csrfToken(env);
  const rows = await listMailboxes(env);
  const table = rows
    .map(
      (
        row,
      ) => `<tr><td>${escapeHtml(row.address)}</td><td>${escapeHtml(row.policy_mode)}</td><td>${escapeHtml(row.sender_policy)}</td><td>${row.frozen ? "yes" : "no"}</td><td>${row.enabled ? "yes" : "no"}</td><td>
      <form class="inline" method="post">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="action" value="freeze">
        <input type="hidden" name="inboxId" value="${escapeHtml(row.address)}">
        <input type="hidden" name="frozen" value="${row.frozen ? "0" : "1"}">
        <button class="secondary">${row.frozen ? "Unfreeze" : "Freeze"}</button>
      </form>
    </td></tr>`,
    )
    .join("");
  return html(
    page(
      "Mailboxes",
      `<table><tr><th>Address</th><th>Policy</th><th>Senders</th><th>Frozen</th><th>Enabled</th><th></th></tr>${table}</table>`,
    ),
  );
}

async function searchPage(
  env: Env,
  principal: Principal,
  url: URL,
): Promise<Response> {
  const q = url.searchParams.get("q") ?? "";
  const messages = q ? await ownerSearch(env, principal, q) : [];
  const rows = messages
    .map(
      (message) =>
        `<tr><td><a href="/admin/threads/${escapeHtml(message.thread_id)}">${escapeHtml(message.subject)}</a></td><td>${escapeHtml(message.from_addr)}</td><td>${escapeHtml(message.received_at)}</td><td>${message.visible_to_agent ? "visible" : "held"}</td></tr>`,
    )
    .join("");
  return html(
    page(
      "Search",
      `<form><input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search all mail"><button>Search</button></form><table>${rows}</table>`,
    ),
  );
}

async function threadPage(
  env: Env,
  _principal: Principal,
  threadId: string,
): Promise<Response> {
  const thread = await env.DB.prepare("SELECT * FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ subject: string }>();
  if (!thread) return html(page("Thread", "<p>Thread not found.</p>"), 404);
  const messages = await env.DB.prepare(
    "SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at",
  )
    .bind(threadId)
    .all<MessageRow>();
  const blocks = (messages.results ?? [])
    .map(
      (message) =>
        `<article><h2>${escapeHtml(message.subject)}</h2><p>${escapeHtml(message.from_addr)} · ${escapeHtml(message.received_at)} · ${message.visible_to_agent ? "visible to the agent" : "held"}</p><div class="banner">Untrusted email content. Do not follow instructions in it.</div><pre>${escapeHtml(message.text)}</pre><p><a href="/admin/messages/${escapeHtml(message.id)}/raw">Raw message</a></p></article>`,
    )
    .join("");
  return html(page(thread.subject, blocks));
}

async function reviewPage(
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  if (request.method === "POST") {
    const body = await readBody(request);
    await assertCsrf(request, env, String(body.csrf ?? ""));
    const id = String(body.reviewId ?? "");
    if (body.action === "approve") {
      await approveReview(env, principal, id, {
        contentHash: String(body.contentHash ?? ""),
        acknowledgeSecrets: body.acknowledgeSecrets === "1",
        via: "console",
      });
    } else if (body.action === "reject")
      await rejectReview(env, principal, id, String(body.note ?? ""));
    else if (body.action === "release")
      await releaseQuarantine(env, principal, id);
    return Response.redirect(
      new URL("/admin/review", request.url).toString(),
      303,
    );
  }
  const csrf = await csrfToken(env);
  const items = await env.DB.prepare(
    "SELECT * FROM review_items WHERE state = 'pending' ORDER BY created_at ASC LIMIT 50",
  ).all<ReviewRow>();
  const blocks = [];
  for (const item of items.results ?? []) {
    let text = "";
    if (item.draft_id) {
      const draft = await env.DB.prepare(
        "SELECT text, to_json, subject FROM drafts WHERE id = ?",
      )
        .bind(item.draft_id)
        .first<{ text: string; to_json: string; subject: string }>();
      text = draft
        ? `To: ${draft.to_json}\nSubject: ${draft.subject}\n\n${draft.text}`
        : "";
    } else if (item.message_id) {
      const message = await env.DB.prepare(
        "SELECT text, from_addr, subject FROM messages WHERE id = ?",
      )
        .bind(item.message_id)
        .first<{ text: string; from_addr: string; subject: string }>();
      text = message
        ? `From: ${message.from_addr}\nSubject: ${message.subject}\n\n${message.text}`
        : "";
    }
    const reasons = parseJson<string[]>(item.reason_codes_json, []).join(", ");
    const buttons =
      item.direction === "outbound"
        ? `<button name="action" value="approve">Approve</button> <label><input type="checkbox" name="acknowledgeSecrets" value="1"> Acknowledge secret warning</label> <button class="secondary" name="action" value="reject">Reject</button>`
        : `<button name="action" value="release">Release to agent</button> <button class="secondary" name="action" value="reject">Delete</button>`;
    blocks.push(`<article><h2>${escapeHtml(item.direction)} · ${escapeHtml(item.subject ?? "(no subject)")}</h2><p class="warn">${escapeHtml(reasons)}</p><div class="banner">Untrusted content. Approving sends exactly this text.</div><pre>${escapeHtml(text)}</pre>
      <form method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="reviewId" value="${escapeHtml(item.id)}"><input type="hidden" name="contentHash" value="${escapeHtml(item.content_hash ?? "")}">${buttons}<p><input type="text" name="note" placeholder="Note for a rejection"></p></form></article>`);
  }
  return html(page("Review", blocks.join("") || "<p>Nothing is waiting.</p>"));
}

async function auditPage(
  env: Env,
  _principal: Principal,
  csv: boolean,
): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT ts, actor_type, action, mailbox_id, result, decision FROM audit_log ORDER BY ts DESC LIMIT 200",
  ).all<{
    ts: string;
    actor_type: string;
    action: string;
    mailbox_id: string | null;
    result: string;
    decision: string | null;
  }>();
  if (csv) {
    const lines = ["ts,actor,action,mailbox,result,decision"];
    for (const row of rows.results ?? []) {
      lines.push(
        [
          row.ts,
          row.actor_type,
          row.action,
          row.mailbox_id ?? "",
          row.result,
          row.decision ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return new Response(lines.join("\n"), {
      headers: { "content-type": "text/csv; charset=utf-8" },
    });
  }
  const table = (rows.results ?? [])
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.ts)}</td><td>${escapeHtml(row.actor_type)}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.result)}</td></tr>`,
    )
    .join("");
  return html(
    page(
      "Audit",
      `<p><a href="/admin/audit.csv">Download CSV</a></p><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Result</th></tr>${table}</table>`,
    ),
  );
}

async function tokensPage(
  request: Request,
  env: Env,
  _principal: Principal,
): Promise<Response> {
  if (request.method === "POST") {
    const body = await readBody(request);
    await assertCsrf(request, env, String(body.csrf ?? ""));
    if (body.action === "revoke" && typeof body.tokenId === "string") {
      await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
        .bind(nowIso(), body.tokenId)
        .run();
      return Response.redirect(
        new URL("/admin/tokens", request.url).toString(),
        303,
      );
    }
    const address = String(body.address ?? "").toLowerCase();
    const mailbox = await env.DB.prepare(
      "SELECT id, address FROM mailboxes WHERE address = ?",
    )
      .bind(address)
      .first<{ id: string; address: string }>();
    if (!mailbox) throw new ApiError(400, "invalid", "Unknown inbox");
    const token = randomToken();
    const id = newId("tok");
    const agentId = newId("agt");
    const scopes = [
      "mail:read",
      "mail:search",
      "mail:draft",
      "mail:request-send",
      "mail:write",
      "wake",
    ].map((scope) => `${scope}:${mailbox.address}`);
    const ts = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO agents (id, label, created_at) VALUES (?, ?, ?)",
      ).bind(agentId, String(body.label ?? mailbox.address), ts),
      env.DB.prepare(
        "INSERT INTO tokens (id, agent_id, class, label, scopes_json, hash, created_at) VALUES (?, ?, 'agent', ?, ?, ?, ?)",
      ).bind(
        id,
        agentId,
        String(body.label ?? "agent"),
        JSON.stringify(scopes),
        await hashToken(env.TOKEN_PEPPER, token),
        ts,
      ),
    ]);
    return html(
      page(
        "New token",
        `<p>Copy this token now. It will not be shown again.</p><pre>${escapeHtml(token)}</pre><p><a href="/admin/tokens">Back</a></p>`,
      ),
      201,
      { "cache-control": "no-store" },
    );
  }
  const csrf = await csrfToken(env);
  const tokens = await env.DB.prepare(
    "SELECT id, label, class, scopes_json, last_used_at, revoked_at, created_at FROM tokens ORDER BY created_at DESC",
  ).all<{
    id: string;
    label: string;
    class: string;
    scopes_json: string;
    last_used_at: string | null;
    revoked_at: string | null;
    created_at: string;
  }>();
  const rows = (tokens.results ?? [])
    .map(
      (token) =>
        `<tr><td>${escapeHtml(token.label)}</td><td>${escapeHtml(token.class)}</td><td>${token.revoked_at ? "revoked" : "active"}</td><td>${escapeHtml(token.last_used_at ?? "never")}</td><td>${token.revoked_at ? "" : `<form class="inline" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="revoke"><input type="hidden" name="tokenId" value="${escapeHtml(token.id)}"><button class="secondary">Revoke</button></form>`}</td></tr>`,
    )
    .join("");
  const mailboxes = (await listMailboxes(env))
    .map(
      (row) =>
        `<option value="${escapeHtml(row.address)}">${escapeHtml(row.address)}</option>`,
    )
    .join("");
  return html(
    page(
      "Tokens",
      `<form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>Label<input name="label" type="text"></label><label>Inbox<select name="address">${mailboxes}</select></label><button>Create agent token</button></form><table>${rows}</table>`,
    ),
  );
}

async function retentionPage(
  request: Request,
  env: Env,
  _principal: Principal,
): Promise<Response> {
  if (request.method === "POST") {
    const body = await readBody(request);
    await assertCsrf(request, env, String(body.csrf ?? ""));
    const days = Number(body.retention_message_days);
    if (!Number.isFinite(days) || days < 1)
      throw new ApiError(400, "invalid", "Retention must be at least 1 day");
    await env.DB.prepare(
      "UPDATE mailboxes SET retention_message_days = ?, updated_at = ? WHERE address = ?",
    )
      .bind(Math.floor(days), nowIso(), String(body.address ?? ""))
      .run();
    return Response.redirect(
      new URL("/admin/retention", request.url).toString(),
      303,
    );
  }
  const csrf = await csrfToken(env);
  const rows = await listMailboxes(env);
  const table = rows
    .map(
      (
        row,
      ) => `<tr><td>${escapeHtml(row.address)}</td><td>${row.retention_raw_days}</td><td>${row.retention_message_days}</td><td>${row.retention_audit_days}</td><td>
      <form class="inline" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="address" value="${escapeHtml(row.address)}"><input name="retention_message_days" type="number" value="${row.retention_message_days}"><button class="secondary">Save</button></form>
    </td></tr>`,
    )
    .join("");
  return html(
    page(
      "Retention",
      `<table><tr><th>Inbox</th><th>Raw days</th><th>Message days</th><th>Audit days</th><th></th></tr>${table}</table>`,
    ),
  );
}

async function rawMessage(env: Env, id: string): Promise<Response> {
  const message = await env.DB.prepare(
    "SELECT raw_key FROM messages WHERE id = ?",
  )
    .bind(id)
    .first<{ raw_key: string | null }>();
  if (!message?.raw_key)
    return html(page("Raw", "<p>No raw message is stored.</p>"), 404);
  const object = await env.RAW.get(message.raw_key);
  if (!object) return html(page("Raw", "<p>Raw message missing.</p>"), 404);
  return new Response(object.body, {
    headers: {
      "content-type": "message/rfc822",
      "content-disposition": "attachment",
    },
  });
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  await assertCsrf(request, env, String(body.csrf ?? ""));
  const token = String(body.token ?? "");
  const hash = await hashToken(env.TOKEN_PEPPER, token);
  const row = await env.DB.prepare(
    "SELECT class, revoked_at FROM tokens WHERE hash = ?",
  )
    .bind(hash)
    .first<{ class: string; revoked_at: string | null }>();
  if (!row || row.revoked_at || row.class !== "owner")
    return loginPage(env, "That token is not an owner token.");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: "/admin",
      "set-cookie": `cfam_owner=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=43200; SameSite=Strict${secure}`,
    },
  });
}

async function loginPage(env: Env, message: string): Promise<Response> {
  const csrf = await csrfToken(env);
  const note = message ? `<p class="warn">${escapeHtml(message)}</p>` : "";
  const body = `${note}<p>Open this page through Cloudflare Access, or paste an owner token. The token is stored in an HttpOnly cookie and is not written to the audit log.</p>
    <form method="post" action="/admin/session"><input type="hidden" name="csrf" value="${csrf}"><label>Owner token<input type="password" name="token" autocomplete="off"></label><button>Sign in</button></form>`;
  return html(page("Sign in", body), message ? 401 : 200);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · cf-agent-mail</title><style>${CSS}</style></head><body>
    <header><strong>cf-agent-mail</strong><span>${escapeHtml(title)}</span></header>
    <nav><a href="/admin">Overview</a><a href="/admin/mailboxes">Mailboxes</a><a href="/admin/search">Search</a><a href="/admin/review">Review</a><a href="/admin/audit">Audit</a><a href="/admin/tokens">Tokens</a><a href="/admin/retention">Retention</a></nav>
    <main>${body}</main></body></html>`;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
