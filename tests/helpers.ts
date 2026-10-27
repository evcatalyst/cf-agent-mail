import { applyD1Migrations, env, reset } from "cloudflare:test";
import { hashToken } from "../src/crypto";
import { nowIso } from "../src/ids";

export const OWNER = "cam_owner_test_token_value";
export const SURVEYS = "cam_surveys_test_token_value";
export const SOCIALS = "cam_socials_test_token_value";
export const SYSTEM = "cam_system_test_token_value";

export const SURVEYS_ADDRESS = "surveys@mail.example.com";
export const SOCIALS_ADDRESS = "socials@mail.example.com";
export const KNOWN_ADDRESS = "known@mail.example.com";
export const TEMPLATES_ADDRESS = "templates@mail.example.com";

type Migration = { name: string; queries: string[] };

export async function fresh(): Promise<void> {
  await reset();
  const migrations = (env as Env & { TEST_MIGRATIONS: Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations);
  const ts = nowIso();
  const rows: [string, string, string, string, string][] = [
    ["mbx_surveys000001", "surveys", SURVEYS_ADDRESS, "Surveys", "strict"],
    ["mbx_socials000001", "socials", SOCIALS_ADDRESS, "Socials", "strict"],
    ["mbx_known00000001", "known", KNOWN_ADDRESS, "Known", "known-auto"],
    [
      "mbx_templates0001",
      "templates",
      TEMPLATES_ADDRESS,
      "Templates",
      "template-only",
    ],
  ];
  for (const [id, slug, address, name, mode] of rows) {
    await env.DB.prepare(
      `INSERT INTO mailboxes (id, slug, domain, address, display_name, policy_mode, created_at, updated_at)
       VALUES (?, ?, 'mail.example.com', ?, ?, ?, ?, ?)`,
    )
      .bind(id, slug, address, name, mode, ts, ts)
      .run();
  }
  await putToken(
    "tok_owner0000001",
    null,
    "owner",
    "owner",
    [
      "admin",
      "system:send:otp",
      "system:send:alert",
      "system:send:digest",
      "system:send:notify",
    ],
    OWNER,
    ts,
  );
  await putToken(
    "tok_surveys00001",
    "agt_surveys0001",
    "agent",
    "surveys",
    scopesFor(SURVEYS_ADDRESS),
    SURVEYS,
    ts,
  );
  await putToken(
    "tok_socials00001",
    "agt_socials0001",
    "agent",
    "socials",
    scopesFor(SOCIALS_ADDRESS),
    SOCIALS,
    ts,
  );
  await putToken(
    "tok_system000001",
    "agt_system00001",
    "agent",
    "system",
    ["system:send:otp"],
    SYSTEM,
    ts,
  );
  await env.DB.prepare(
    "INSERT INTO agents (id, label, created_at) VALUES (?, ?, ?)",
  )
    .bind("agt_surveys0001", "surveys", ts)
    .run();
  await env.DB.prepare(
    "INSERT INTO agents (id, label, created_at) VALUES (?, ?, ?)",
  )
    .bind("agt_socials0001", "socials", ts)
    .run();
  await env.DB.prepare(
    "INSERT INTO agents (id, label, created_at) VALUES (?, ?, ?)",
  )
    .bind("agt_system00001", "system", ts)
    .run();
}

function scopesFor(address: string): string[] {
  return [
    "mail:read",
    "mail:search",
    "mail:draft",
    "mail:request-send",
    "mail:write",
    "wake",
  ].map((scope) => `${scope}:${address}`);
}

async function putToken(
  id: string,
  agentId: string | null,
  cls: string,
  label: string,
  scopes: string[],
  token: string,
  ts: string,
) {
  await env.DB.prepare(
    "INSERT INTO tokens (id, agent_id, class, label, scopes_json, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      agentId,
      cls,
      label,
      JSON.stringify(scopes),
      await hashToken(env.TOKEN_PEPPER, token),
      ts,
    )
    .run();
}

export function mime(headers: Record<string, string>, body: string): string {
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}`,
  );
  return `${lines.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export function inboundMessage(
  raw: string,
  from: string,
  to: string,
): { message: ForwardableEmailMessage; rejected: () => string | undefined } {
  let reason: string | undefined;
  const bytes = new TextEncoder().encode(raw);
  const message = {
    from,
    to,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
    setReject(value: string) {
      reason = value;
    },
    async forward() {
      throw new Error("forward is unused");
    },
    async reply() {
      throw new Error("reply is unused");
    },
  } as ForwardableEmailMessage;
  return { message, rejected: () => reason };
}

export async function api(
  path: string,
  token?: string,
  init: RequestInit = {},
): Promise<{ status: number; json: any; text: string }> {
  const { SELF } = await import("cloudflare:test");
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await SELF.fetch(
    new Request(`https://relay.example.com${path}`, { ...init, headers }),
  );
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}
