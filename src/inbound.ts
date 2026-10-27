import { splitLocal } from "./address";
import { newId, nowIso } from "./ids";
import { LIMITS } from "./limits";
import { handleParseJob, type ParseJob } from "./pipeline";
import type { MailboxRow } from "./store";

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  try {
    const target = splitLocal(message.to);
    if (!target || target.domain !== env.MAIL_DOMAIN.toLowerCase()) {
      message.setReject("Unknown recipient");
      return;
    }
    if (message.rawSize > LIMITS.inboundMax) {
      message.setReject("Message too large");
      return;
    }
    const mailbox = await env.DB.prepare(
      "SELECT * FROM mailboxes WHERE slug = ? AND domain = ?",
    )
      .bind(target.slug, target.domain)
      .first<MailboxRow>();
    if (mailbox?.enabled !== 1) {
      message.setReject("Unknown recipient");
      return;
    }
    const blocked = await env.DB.prepare(
      `SELECT id FROM list_entries
       WHERE mailbox_id = ? AND direction = 'receive' AND list_type = 'block' AND (entry = ? OR entry = ?)
       LIMIT 1`,
    )
      .bind(
        mailbox.id,
        message.from.toLowerCase(),
        message.from.split("@")[1]?.toLowerCase() ?? "",
      )
      .first<{ id: string }>();
    if (blocked) {
      message.setReject("Rejected");
      return;
    }
    const receivedAt = nowIso();
    const key = `raw/${receivedAt.slice(0, 4)}/${receivedAt.slice(5, 7)}/${newId("raw")}.eml`;
    const raw = await readRaw(message.raw);
    await env.RAW.put(key, raw, {
      customMetadata: {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        receivedAt,
        rawSize: String(raw.byteLength),
      },
    });
    const job: ParseJob = {
      rawKey: key,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      receivedAt,
      rawSize: raw.byteLength,
    };
    await env.PARSE_QUEUE.send(job);
    if (env.INLINE_PARSE === "1") ctx.waitUntil(handleParseJob(env, job));
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "inbound_failed",
        error: error instanceof Error ? error.name : "error",
      }),
    );
    throw error;
  }
}

async function readRaw(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    size += value.byteLength;
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}
