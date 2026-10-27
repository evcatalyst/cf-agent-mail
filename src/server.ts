import * as actions from "./actions";
import { handleAdmin } from "./admin";
import { authenticate, ownerFromRequest } from "./authz";
import { hmacHex, timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import { errorResponse, json, parts, readBody } from "./http";
import { handleMcp } from "./mcp";
import { handleProviderEvent } from "./pipeline";
import { asString } from "./ids";
export async function handleFetch(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/mcp") return await handleMcp(request, env);
    if (url.pathname.startsWith("/admin/api/"))
      return await adminApi(request, env, url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
      return await handleAdmin(request, env, url);
    if (
      url.pathname.startsWith("/v1/attachments/") &&
      url.pathname.endsWith("/download")
    ) {
      return await downloadAttachment(request, env, url);
    }
    if (url.pathname === "/v1/provider/events" && request.method === "POST")
      return await providerEvent(request, env);
    if (url.pathname.startsWith("/v1/")) return await rest(request, env, url);
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

async function rest(request: Request, env: Env, url: URL): Promise<Response> {
  const principal = await authenticate(request, env);
  const path = parts(url);
  const body = await readBody(request);
  const query = Object.fromEntries(url.searchParams.entries());
  if (path[1] === "system" && path[2] === "send" && request.method === "POST") {
    return json(
      await actions.systemSend(
        env,
        principal,
        body as Parameters<typeof actions.systemSend>[2],
      ),
      200,
    );
  }
  if (path[1] === "events" && request.method === "GET") {
    return json(
      await actions.listEvents(env, principal, {
        since: query.since,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    );
  }
  if (path[1] !== "inboxes")
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  const inboxId = path[2];
  if (!inboxId && request.method === "GET")
    return json(
      await actions.listInboxes(env, principal, {
        limit: num(query.limit),
        pageToken: query.pageToken,
      }),
    );
  if (!inboxId && request.method === "POST")
    return json(
      await actions.createInbox(
        env,
        principal,
        body as Parameters<typeof actions.createInbox>[2],
      ),
      201,
    );
  if (!inboxId) throw new ApiError(404, "not_found", "Not found");
  if (path.length === 3 && request.method === "GET")
    return json(await actions.getInbox(env, principal, inboxId));
  if (path.length === 3 && request.method === "PATCH")
    return json(
      await actions.updateInbox(
        env,
        principal,
        inboxId,
        body as Parameters<typeof actions.updateInbox>[3],
      ),
    );
  if (path.length === 3 && request.method === "DELETE")
    return json(await actions.deleteInbox(env, principal, inboxId));
  const resource = path[3];
  if (resource === "threads" && path.length === 4 && request.method === "GET") {
    return json(
      await actions.listThreads(env, principal, {
        inboxId,
        ...query,
        limit: num(query.limit),
        labels: url.searchParams.getAll("labels"),
      }),
    );
  }
  if (
    resource === "threads" &&
    path[4] === "search" &&
    request.method === "GET"
  ) {
    return json(
      await actions.searchThreads(env, principal, {
        inboxId,
        q: query.q,
        limit: num(query.limit),
      }),
    );
  }
  if (
    resource === "threads" &&
    path[4] &&
    path.length === 5 &&
    request.method === "GET"
  ) {
    return json(
      await actions.getThread(env, principal, {
        inboxId,
        threadId: path[4],
        limit: num(query.limit),
        pageToken: query.pageToken,
      }),
    );
  }
  if (resource === "threads" && path[4] && request.method === "PATCH") {
    return json(
      await actions.updateThread(env, principal, {
        inboxId,
        threadId: path[4],
        ...(body as object),
      }),
    );
  }
  if (resource === "threads" && path[4] && request.method === "DELETE") {
    return json(
      await actions.deleteThread(env, principal, {
        inboxId,
        threadId: path[4],
      }),
    );
  }
  if (
    resource === "messages" &&
    path[4] === "search" &&
    request.method === "GET"
  ) {
    return json(
      await actions.searchMessages(env, principal, { inboxId, q: query.q }),
    );
  }
  if (
    resource === "messages" &&
    path[4] === "send" &&
    request.method === "POST"
  ) {
    return json(
      await actions.sendMessage(env, principal, { inboxId, ...body }),
      202,
    );
  }
  if (
    resource === "messages" &&
    path.length === 4 &&
    request.method === "GET"
  ) {
    return json(
      await actions.listMessages(env, principal, {
        inboxId,
        ...query,
        limit: num(query.limit),
      }),
    );
  }
  if (
    resource === "messages" &&
    path[4] &&
    path.length === 5 &&
    request.method === "GET"
  ) {
    return json(
      await actions.getMessage(env, principal, { inboxId, messageId: path[4] }),
    );
  }
  if (
    resource === "messages" &&
    path[4] &&
    path[5] === "reply" &&
    request.method === "POST"
  ) {
    return json(
      await actions.replyToMessage(env, principal, {
        inboxId,
        messageId: path[4],
        ...body,
      }),
      202,
    );
  }
  if (
    resource === "messages" &&
    path[4] &&
    path[5] === "forward" &&
    request.method === "POST"
  ) {
    return json(
      await actions.forwardMessage(env, principal, {
        inboxId,
        messageId: path[4],
        ...body,
      }),
      202,
    );
  }
  if (resource === "messages" && path[4] && request.method === "PATCH") {
    return json(
      await actions.updateMessage(env, principal, {
        inboxId,
        messageId: path[4],
        ...(body as object),
      }),
    );
  }
  if (
    resource === "messages" &&
    path[4] === undefined &&
    path[5] === "attachments"
  ) {
    return json(
      await actions.getAttachment(env, principal, {
        inboxId,
        threadId: "",
        attachmentId: path[6] ?? "",
      }),
    );
  }
  if (resource === "messages" && path[5] === "attachments" && path[6]) {
    const message = await actions.getMessage(env, principal, {
      inboxId,
      messageId: path[4],
    });
    return json(
      await actions.getAttachment(env, principal, {
        inboxId,
        threadId: String(message.threadId),
        attachmentId: path[6],
      }),
    );
  }
  if (resource === "drafts" && path.length === 4 && request.method === "GET")
    return json(
      await actions.listDrafts(env, principal, {
        inboxId,
        limit: num(query.limit),
      }),
    );
  if (resource === "drafts" && path.length === 4 && request.method === "POST")
    return json(
      await actions.createDraft(env, principal, { inboxId, ...body }),
      201,
    );
  if (
    resource === "drafts" &&
    path[4] &&
    path.length === 5 &&
    request.method === "GET"
  )
    return json(
      await actions.getDraft(env, principal, { inboxId, draftId: path[4] }),
    );
  if (resource === "drafts" && path[4] && request.method === "PATCH")
    return json(
      await actions.updateDraft(env, principal, {
        inboxId,
        draftId: path[4],
        ...body,
      }),
    );
  if (resource === "drafts" && path[4] && request.method === "DELETE")
    return json(
      await actions.deleteDraft(env, principal, { inboxId, draftId: path[4] }),
    );
  if (
    resource === "drafts" &&
    path[4] &&
    path[5] === "send" &&
    request.method === "POST"
  ) {
    return json(
      await actions.sendDraft(env, principal, { inboxId, draftId: path[4] }),
      202,
    );
  }
  if (resource === "lists" && path[4] && path[5] && request.method === "GET") {
    return json(
      await actions.listListEntries(env, principal, {
        inboxId,
        direction: path[4],
        listType: path[5],
      }),
    );
  }
  if (resource === "lists" && path[4] && path[5] && request.method === "POST") {
    return json(
      await actions.createListEntry(env, principal, {
        inboxId,
        direction: path[4],
        listType: path[5],
        entry: String(body.entry ?? ""),
        reason: typeof body.reason === "string" ? body.reason : undefined,
      }),
      201,
    );
  }
  if (
    resource === "lists" &&
    path[4] &&
    path[5] &&
    path[6] &&
    request.method === "DELETE"
  ) {
    return json(
      await actions.deleteListEntry(env, principal, {
        inboxId,
        direction: path[4],
        listType: path[5],
        entry: path[6],
      }),
    );
  }
  throw new ApiError(404, "not_found", "Not found");
}

async function adminApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const principal = await ownerFromRequest(request, env);
  const path = parts(url);
  const body = await readBody(request);
  if (path[2] === "freeze" && request.method === "POST")
    return json(
      await actions.setGlobalFreeze(env, principal, body.frozen !== false),
    );
  if (
    path[2] === "review" &&
    path[3] &&
    path[4] === "approve" &&
    request.method === "POST"
  ) {
    return json(
      await actions.approveReview(env, principal, path[3], {
        contentHash: String(body.contentHash ?? ""),
        acknowledgeSecrets: body.acknowledgeSecrets === true,
        raiseCap: body.raiseCap === true,
        via: "api",
      }),
    );
  }
  if (
    path[2] === "review" &&
    path[3] &&
    path[4] === "reject" &&
    request.method === "POST"
  ) {
    return json(
      await actions.rejectReview(
        env,
        principal,
        path[3],
        typeof body.note === "string" ? body.note : undefined,
      ),
    );
  }
  if (
    path[2] === "quarantine" &&
    path[3] &&
    path[4] === "release" &&
    request.method === "POST"
  ) {
    return json(await actions.releaseQuarantine(env, principal, path[3]));
  }
  throw new ApiError(404, "not_found", "Not found");
}

async function providerEvent(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const expected = `sha256=${await hmacHex(env.WEBHOOK_SIGNING_KEY, raw)}`;
  const signature = request.headers.get("x-cf-agent-mail-signature") ?? "";
  const signed = signature.length > 0 && timingSafeEqual(signature, expected);
  if (!signed) {
    const header =
      request.headers.get("authorization") ?? request.headers.get("x-api-key");
    if (!header)
      throw new ApiError(401, "unauthorized", "Missing event signature");
    const principal = await authenticate(request, env);
    if (principal.class !== "owner")
      throw new ApiError(403, "forbidden", "Owner token required");
  }
  const body = JSON.parse(raw) as Record<string, unknown>;
  await env.EVENTS_QUEUE.send(body);
  if (asString(env.INLINE_PARSE) === "1") await handleProviderEvent(env, body);
  return json({ ok: true });
}

async function downloadAttachment(
  _request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const id = parts(url)[2];
  const exp = Number(url.searchParams.get("exp") ?? 0);
  const sig = url.searchParams.get("sig") ?? "";
  if (!id || !exp || !sig || exp < Date.now())
    throw new ApiError(403, "forbidden", "Download link expired");
  const { hmacHex } = await import("./crypto");
  const expected = (await hmacHex(env.TOKEN_PEPPER, `${id}.${exp}`)).slice(
    0,
    32,
  );
  if (!timingSafeEqual(sig, expected))
    throw new ApiError(403, "forbidden", "Download link rejected");
  const row = await env.DB.prepare(
    "SELECT r2_key, name, type, risk FROM attachments WHERE id = ?",
  )
    .bind(id)
    .first<{ r2_key: string; name: string; type: string; risk: string }>();
  if (!row || row.risk === "high")
    throw new ApiError(404, "not_found", "Attachment not found");
  const object = await env.ATTACHMENTS.get(row.r2_key);
  if (!object) throw new ApiError(404, "not_found", "Attachment not found");
  return new Response(object.body, {
    headers: {
      "content-type": row.type,
      "content-disposition": `attachment; filename="${row.name.replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

function num(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
