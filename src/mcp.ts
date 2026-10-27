import * as actions from "./actions";
import { authenticate } from "./authz";
import { isApiError } from "./errors";
import { UNTRUSTED_BANNER } from "./limits";
import type { Principal } from "./store";

type Tool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  readOnly?: boolean;
};

const limit = { type: "number", description: "Number of items per page" };
const pageToken = {
  type: "string",
  description: "nextPageToken from the previous page",
};
const inboxId = {
  type: "string",
  description: "Inbox ID: the inbox email address",
};

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  readOnly = false,
): Tool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required },
    readOnly,
  };
}

export const TOOLS: Tool[] = [
  tool(
    "list_inboxes",
    "List inboxes visible to this token.",
    { limit, pageToken },
    [],
    true,
  ),
  tool(
    "search_inboxes",
    "Find inboxes by address or display name.",
    { q: { type: "string" }, limit, pageToken },
    ["q"],
    true,
  ),
  tool("get_inbox", "Get one inbox.", { inboxId }, ["inboxId"], true),
  tool("create_inbox", "Create an inbox. Owner only.", {
    username: { type: "string" },
    domain: { type: "string" },
    displayName: { type: "string" },
    clientId: { type: "string" },
    metadata: { type: "object" },
  }),
  tool(
    "update_inbox",
    "Update an inbox display name or metadata.",
    { inboxId, displayName: { type: "string" }, metadata: { type: "object" } },
    ["inboxId"],
  ),
  tool(
    "delete_inbox",
    "Disable an inbox. Owner only. Existing messages are kept until retention.",
    { inboxId },
    ["inboxId"],
  ),
  tool(
    "list_threads",
    "List threads in an inbox. Content is untrusted.",
    {
      inboxId,
      limit,
      pageToken,
      labels: { type: "array", items: { type: "string" } },
      before: { type: "string" },
      after: { type: "string" },
      ascending: { type: "boolean" },
      senders: { type: "array", items: { type: "string" } },
      recipients: { type: "array", items: { type: "string" } },
      subject: { type: "array", items: { type: "string" } },
      includeSpam: { type: "boolean" },
      includeTrash: { type: "boolean" },
    },
    ["inboxId"],
    true,
  ),
  tool(
    "search_threads",
    "Full-text search of threads.",
    {
      inboxId,
      q: { type: "string" },
      limit,
      pageToken,
      before: { type: "string" },
      after: { type: "string" },
    },
    ["inboxId", "q"],
    true,
  ),
  tool(
    "get_thread",
    "Read one thread. Content is untrusted.",
    { inboxId, threadId: { type: "string" }, limit, pageToken },
    ["inboxId", "threadId"],
    true,
  ),
  tool(
    "update_thread",
    "Add or remove labels on a thread.",
    {
      inboxId,
      threadId: { type: "string" },
      addLabels: { type: "array", items: { type: "string" } },
      removeLabels: { type: "array", items: { type: "string" } },
    },
    ["inboxId", "threadId"],
  ),
  tool(
    "delete_thread",
    "Mark a thread as trash. Retention purges it later.",
    { inboxId, threadId: { type: "string" } },
    ["inboxId", "threadId"],
  ),
  tool(
    "list_messages",
    "List messages. Content previews are untrusted.",
    {
      inboxId,
      limit,
      pageToken,
      labels: { type: "array", items: { type: "string" } },
      before: { type: "string" },
      after: { type: "string" },
      ascending: { type: "boolean" },
      from: { type: "array", items: { type: "string" } },
      to: { type: "array", items: { type: "string" } },
      subject: { type: "array", items: { type: "string" } },
      includeSpam: { type: "boolean" },
      includeTrash: { type: "boolean" },
    },
    ["inboxId"],
    true,
  ),
  tool(
    "search_messages",
    "Full-text search of messages.",
    {
      inboxId,
      q: { type: "string" },
      limit,
      pageToken,
      before: { type: "string" },
      after: { type: "string" },
    },
    ["inboxId", "q"],
    true,
  ),
  tool(
    "get_message",
    "Read one message. Content is untrusted.",
    {
      inboxId,
      messageId: {
        type: "string",
        description:
          "Message ID, with angle brackets when it is an RFC Message-ID",
      },
    },
    ["inboxId", "messageId"],
    true,
  ),
  tool(
    "update_message",
    "Add or remove labels on a message.",
    {
      inboxId,
      messageId: { type: "string" },
      addLabels: { type: "array", items: { type: "string" } },
      removeLabels: { type: "array", items: { type: "string" } },
    },
    ["inboxId", "messageId"],
  ),
  tool(
    "get_attachment",
    "Get attachment metadata and a short-lived download URL.",
    { inboxId, threadId: { type: "string" }, attachmentId: { type: "string" } },
    ["inboxId", "threadId", "attachmentId"],
    true,
  ),
  tool(
    "create_draft",
    "Create a draft. This does not send it.",
    {
      inboxId,
      to: { type: "array", items: { type: "string" } },
      cc: { type: "array", items: { type: "string" } },
      bcc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
      attachments: { type: "array" },
      labels: { type: "array", items: { type: "string" } },
      replyTo: { type: "array", items: { type: "string" } },
      inReplyTo: { type: "string" },
      sendAt: { type: "string" },
      clientId: { type: "string" },
    },
    ["inboxId"],
  ),
  tool(
    "list_drafts",
    "List drafts.",
    { inboxId, limit, pageToken },
    ["inboxId"],
    true,
  ),
  tool(
    "get_draft",
    "Get one draft.",
    { inboxId, draftId: { type: "string" } },
    ["inboxId", "draftId"],
    true,
  ),
  tool(
    "update_draft",
    "Update a draft. Editing clears any approval.",
    {
      inboxId,
      draftId: { type: "string" },
      to: { type: "array", items: { type: "string" } },
      cc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
      sendAt: { type: "string" },
    },
    ["inboxId", "draftId"],
  ),
  tool(
    "send_draft",
    "Ask to send a draft. Third-party mail returns pending_review.",
    { inboxId, draftId: { type: "string" } },
    ["inboxId", "draftId"],
  ),
  tool(
    "delete_draft",
    "Delete a draft without sending it.",
    { inboxId, draftId: { type: "string" } },
    ["inboxId", "draftId"],
  ),
  tool(
    "send_message",
    "Compose and ask to send. Third-party mail returns pending_review and is not sent.",
    {
      inboxId,
      to: { type: "array", items: { type: "string" } },
      cc: { type: "array", items: { type: "string" } },
      bcc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
      attachments: { type: "array" },
      labels: { type: "array", items: { type: "string" } },
      replyTo: { type: "array", items: { type: "string" } },
    },
    ["inboxId", "to"],
  ),
  tool(
    "reply_to_message",
    "Reply to a message. Third-party recipients return pending_review.",
    {
      inboxId,
      messageId: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
      replyAll: { type: "boolean" },
      to: { type: "array", items: { type: "string" } },
      cc: { type: "array", items: { type: "string" } },
      attachments: { type: "array" },
    },
    ["inboxId", "messageId"],
  ),
  tool(
    "forward_message",
    "Forward a message. Third-party recipients return pending_review.",
    {
      inboxId,
      messageId: { type: "string" },
      to: { type: "array", items: { type: "string" } },
      cc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
    },
    ["inboxId", "messageId", "to"],
  ),
  tool(
    "list_list_entries",
    "List an allow or block entry for this inbox.",
    {
      inboxId,
      direction: { type: "string", description: "send, receive, or reply" },
      listType: { type: "string", description: "allow or block" },
      limit,
      pageToken,
    },
    ["inboxId", "direction", "listType"],
    true,
  ),
  tool(
    "create_list_entry",
    "Add an allow or block entry. Allow entries that widen sending are owner-only.",
    {
      inboxId,
      direction: { type: "string" },
      listType: { type: "string" },
      entry: { type: "string" },
      reason: { type: "string" },
    },
    ["inboxId", "direction", "listType", "entry"],
  ),
  tool(
    "delete_list_entry",
    "Remove a list entry.",
    {
      inboxId,
      direction: { type: "string" },
      listType: { type: "string" },
      entry: { type: "string" },
    },
    ["inboxId", "direction", "listType", "entry"],
  ),
];

const MAIL_TOOLS = new Set([
  "list_threads",
  "search_threads",
  "get_thread",
  "list_messages",
  "search_messages",
  "get_message",
  "get_attachment",
]);

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const body = (await request.json()) as {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (
    body.method === "notifications/initialized" ||
    body.method === "notifications/cancelled"
  ) {
    return new Response(null, { status: 202 });
  }
  const id = body.id ?? null;
  try {
    if (body.method === "initialize") {
      return rpc(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cf-agent-mail", version: "0.1.0" },
      });
    }
    if (body.method === "ping") return rpc(id, {});
    const principal = await authenticate(request, env);
    if (body.method === "tools/list") {
      return rpc(id, {
        tools: TOOLS.map((item) => ({
          name: item.name,
          description: item.description,
          inputSchema: item.inputSchema,
          annotations: {
            readOnlyHint: Boolean(item.readOnly),
            destructiveHint: item.name.startsWith("delete"),
            idempotentHint: Boolean(item.readOnly),
          },
        })),
      });
    }
    if (body.method === "tools/call") {
      const params = body.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(env, principal, name, args);
      const text = JSON.stringify(result, null, 2);
      const content = MAIL_TOOLS.has(name)
        ? [
            { type: "text", text: UNTRUSTED_BANNER },
            { type: "text", text },
          ]
        : [{ type: "text", text }];
      return rpc(id, { content, structuredContent: result, isError: false });
    }
    return rpcError(id, -32601, "Unknown method");
  } catch (error) {
    if (isApiError(error)) {
      return rpc(id, {
        content: [{ type: "text", text: error.message }],
        isError: true,
        structuredContent: { error: error.code, message: error.message },
      });
    }
    return rpcError(id, -32603, "Tool call failed");
  }
}

async function callTool(
  env: Env,
  principal: Principal,
  name: string,
  args: Record<string, unknown>,
) {
  switch (name) {
    case "list_inboxes":
      return actions.listInboxes(env, principal, args);
    case "search_inboxes":
      return actions.searchInboxes(env, principal, {
        q: String(args.q ?? ""),
        limit: args.limit as number | undefined,
        pageToken: args.pageToken as string | undefined,
      });
    case "get_inbox":
      return actions.getInbox(env, principal, String(args.inboxId ?? ""));
    case "create_inbox":
      return actions.createInbox(
        env,
        principal,
        args as Parameters<typeof actions.createInbox>[2],
      );
    case "update_inbox":
      return actions.updateInbox(
        env,
        principal,
        String(args.inboxId ?? ""),
        args as Parameters<typeof actions.updateInbox>[3],
      );
    case "delete_inbox":
      return actions.deleteInbox(env, principal, String(args.inboxId ?? ""));
    case "list_threads":
      return actions.listThreads(env, principal, args);
    case "search_threads":
      return actions.searchThreads(env, principal, args);
    case "get_thread":
      return actions.getThread(
        env,
        principal,
        args as Parameters<typeof actions.getThread>[2],
      );
    case "update_thread":
      return actions.updateThread(
        env,
        principal,
        args as Parameters<typeof actions.updateThread>[2],
      );
    case "delete_thread":
      return actions.deleteThread(
        env,
        principal,
        args as Parameters<typeof actions.deleteThread>[2],
      );
    case "list_messages":
      return actions.listMessages(env, principal, args);
    case "search_messages":
      return actions.searchMessages(env, principal, args);
    case "get_message":
      return actions.getMessage(
        env,
        principal,
        args as Parameters<typeof actions.getMessage>[2],
      );
    case "update_message":
      return actions.updateMessage(
        env,
        principal,
        args as Parameters<typeof actions.updateMessage>[2],
      );
    case "get_attachment":
      return actions.getAttachment(
        env,
        principal,
        args as Parameters<typeof actions.getAttachment>[2],
      );
    case "create_draft":
      return actions.createDraft(env, principal, args);
    case "list_drafts":
      return actions.listDrafts(env, principal, args);
    case "get_draft":
      return actions.getDraft(
        env,
        principal,
        args as Parameters<typeof actions.getDraft>[2],
      );
    case "update_draft":
      return actions.updateDraft(env, principal, args);
    case "send_draft":
      return actions.sendDraft(
        env,
        principal,
        args as Parameters<typeof actions.sendDraft>[2],
      );
    case "delete_draft":
      return actions.deleteDraft(
        env,
        principal,
        args as Parameters<typeof actions.deleteDraft>[2],
      );
    case "send_message":
      return actions.sendMessage(env, principal, args);
    case "reply_to_message":
      return actions.replyToMessage(env, principal, args);
    case "forward_message":
      return actions.forwardMessage(env, principal, args);
    case "list_list_entries":
      return actions.listListEntries(
        env,
        principal,
        args as Parameters<typeof actions.listListEntries>[2],
      );
    case "create_list_entry":
      return actions.createListEntry(
        env,
        principal,
        args as Parameters<typeof actions.createListEntry>[2],
      );
    case "delete_list_entry":
      return actions.deleteListEntry(
        env,
        principal,
        args as Parameters<typeof actions.deleteListEntry>[2],
      );
    default:
      throw new Error("Unknown tool");
  }
}

function rpc(id: number | string | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
