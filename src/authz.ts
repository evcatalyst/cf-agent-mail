import { hashToken, sha256Hex, timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import type { Principal, TokenRow } from "./store";

export function allowlist(env: Env): string[] {
  return env.OWNER_ALLOWLIST.split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerAddress(env: Env, email: string): boolean {
  return allowlist(env).includes(email.toLowerCase());
}

export function hasScope(
  principal: Principal,
  scope: string,
  address?: string,
): boolean {
  if (principal.class === "owner" && principal.scopes.includes("admin"))
    return true;
  if (
    principal.scopes.includes(scope) ||
    principal.scopes.includes(`${scope}:*`)
  )
    return true;
  if (address && principal.scopes.includes(`${scope}:${address.toLowerCase()}`))
    return true;
  return false;
}

export function assertScope(
  principal: Principal,
  scope: string,
  address?: string,
): void {
  if (!hasScope(principal, scope, address)) {
    throw new ApiError(403, "forbidden", "Token is not allowed to do that");
  }
}

export function visibleMailboxes(
  principal: Principal,
  addresses: string[],
): string[] | "all" {
  if (principal.class === "owner" && principal.scopes.includes("admin"))
    return "all";
  const allowed = new Set<string>();
  for (const scope of principal.scopes) {
    const parts = scope.split(":");
    if (parts.length === 3 && parts[2] && parts[2] !== "*")
      allowed.add(parts[2].toLowerCase());
    if (parts.length === 2 && parts[1] === "*") return "all";
  }
  if (addresses.length === 0) return [...allowed];
  return addresses.filter((address) => allowed.has(address.toLowerCase()));
}

export async function authenticate(
  request: Request,
  env: Env,
): Promise<Principal> {
  const token = bearer(request);
  if (!token) throw new ApiError(401, "unauthorized", "Missing API token");
  await noteFailure(env, request, false);
  const hash = await hashToken(env.TOKEN_PEPPER, token);
  const row = await env.DB.prepare("SELECT * FROM tokens WHERE hash = ?")
    .bind(hash)
    .first<TokenRow>();
  if (!row || row.revoked_at) {
    await noteFailure(env, request, true);
    throw new ApiError(401, "unauthorized", "Invalid API token");
  }
  if (row.expires_at && row.expires_at < new Date().toISOString()) {
    throw new ApiError(401, "unauthorized", "Token expired");
  }
  await env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run();
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(`token:${row.id}`));
  const rate = await stub.consume("api", 120, 60 * 1000);
  if (!rate.ok) {
    throw new ApiError(429, "rate_limited", "Too many requests", {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  return {
    tokenId: row.id,
    class: row.class === "owner" ? "owner" : "agent",
    agentId: row.agent_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    label: row.label,
    ipHash: await ipHash(request, env),
  };
}

export async function ownerFromRequest(
  request: Request,
  env: Env,
): Promise<Principal> {
  const accessEmail = await accessIdentity(request, env);
  if (accessEmail) {
    if (!isOwnerAddress(env, accessEmail)) {
      throw new ApiError(
        403,
        "forbidden",
        "Access identity is not an allow-listed owner",
      );
    }
    return {
      tokenId: "access",
      class: "owner",
      agentId: null,
      scopes: ["admin"],
      label: accessEmail,
      ipHash: await ipHash(request, env),
    };
  }
  const cookieToken = readCookie(request, "cfam_owner");
  if (cookieToken) {
    const principal = await authenticate(withBearer(request, cookieToken), env);
    if (principal.class !== "owner")
      throw new ApiError(403, "forbidden", "Owner token required");
    return principal;
  }
  if (bearer(request)) {
    const principal = await authenticate(request, env);
    if (principal.class !== "owner")
      throw new ApiError(403, "forbidden", "Owner token required");
    return principal;
  }
  throw new ApiError(401, "unauthorized", "Owner sign-in required");
}

export async function csrfToken(
  env: Env,
  hour = Math.floor(Date.now() / 3_600_000),
): Promise<string> {
  const { hmacHex } = await import("./crypto");
  return (await hmacHex(env.TOKEN_PEPPER, `csrf:${hour}`)).slice(0, 32);
}

export async function assertCsrf(
  _request: Request,
  env: Env,
  token: string | undefined,
): Promise<void> {
  if (!token) throw new ApiError(403, "forbidden", "Missing CSRF token");
  const hour = Math.floor(Date.now() / 3_600_000);
  const current = await csrfToken(env, hour);
  const previous = await csrfToken(env, hour - 1);
  if (!timingSafeEqual(token, current) && !timingSafeEqual(token, previous)) {
    throw new ApiError(403, "forbidden", "CSRF token rejected");
  }
}

async function accessIdentity(
  request: Request,
  env: Env,
): Promise<string | null> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  if (!/^[a-z0-9.-]+$/i.test(env.ACCESS_TEAM_DOMAIN)) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(b64urlToString(parts[0])) as {
    kid?: string;
    alg?: string;
  };
  const payload = JSON.parse(b64urlToString(parts[1])) as {
    exp?: number;
    aud?: string | string[];
    email?: string;
  };
  if (header.alg !== "RS256" || !header.kid) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  const response = await fetch(
    `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
  );
  if (!response.ok) return null;
  const certs = (await response.json()) as {
    keys?: JsonWebKey & { kid?: string }[];
  };
  const jwk = certs.keys?.find((key) => key.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid || !payload.email) return null;
  return payload.email.toLowerCase();
}

async function noteFailure(
  env: Env,
  request: Request,
  failed: boolean,
): Promise<void> {
  const key = await ipHash(request, env);
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT count, window_start FROM auth_failures WHERE key = ?",
  )
    .bind(key)
    .first<{ count: number; window_start: number }>();
  const fresh = !row || now - row.window_start > 60_000;
  const count = fresh ? (failed ? 1 : 0) : row.count + (failed ? 1 : 0);
  if (!fresh && row && row.count >= 30) {
    throw new ApiError(
      429,
      "rate_limited",
      "Too many authentication failures",
      { retryAfterSec: 60 },
    );
  }
  if (failed) {
    await env.DB.prepare(
      "INSERT INTO auth_failures (key, count, window_start) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start",
    )
      .bind(key, count, fresh ? now : row.window_start)
      .run();
  }
}

async function ipHash(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return (await sha256Hex(`${env.TOKEN_PEPPER}:${ip}`)).slice(0, 16);
}

function bearer(request: Request): string {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return "";
}

function withBearer(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request.url, { method: request.method, headers });
}

export function readCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function b64urlToString(value: string): string {
  return new TextDecoder().decode(b64urlToBytes(value));
}

function b64urlToBytes(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
