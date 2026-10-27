import { isApiError } from "./errors";

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export function json(
  body: unknown,
  status = 200,
  extra: HeadersInit = {},
): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

export function html(
  body: string,
  status = 200,
  extra: HeadersInit = {},
): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "text/html; charset=utf-8");
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    headers.set(key, value);
  return new Response(body, { status, headers });
}

export function errorResponse(error: unknown): Response {
  if (isApiError(error)) {
    const headers: Record<string, string> = {};
    if (
      error.code === "rate_limited" &&
      typeof error.extra?.retryAfterSec === "number"
    ) {
      headers["retry-after"] = String(error.extra.retryAfterSec);
    }
    return json(
      { error: { code: error.code, message: error.message, ...error.extra } },
      error.status,
      headers,
    );
  }
  console.log(
    JSON.stringify({
      event: "unhandled",
      error: error instanceof Error ? error.message : "error",
    }),
  );
  return json(
    { error: { code: "error", message: "Something went wrong" } },
    500,
  );
}

export async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }
  if (
    type.includes("application/x-www-form-urlencoded") ||
    type.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const body: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") body[key] = value;
    }
    return body;
  }
  return {};
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function parts(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
}
