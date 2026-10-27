import { DurableObject } from "cloudflare:workers";
import type { OutboundPayload } from "./send-payload";

type Bucket = { stamps: number[]; extra: number };

export type ConsumeResult = { ok: true } | { ok: false; retryAfterSec: number };

export type DeliverResult =
  | { ok: true; messageId: string; internal: boolean }
  | { ok: false; code: string; retryAfterSec?: number };

export class Mailbox extends DurableObject<Env> {
  async consume(
    bucket: string,
    limit: number,
    windowMs: number,
  ): Promise<ConsumeResult> {
    const now = Date.now();
    const state = (await this.ctx.storage.get<Bucket>(`bucket:${bucket}`)) ?? {
      stamps: [],
      extra: 0,
    };
    const stamps = state.stamps.filter((stamp) => now - stamp < windowMs);
    const allowed = limit + state.extra;
    if (stamps.length >= allowed) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((stamps[0] + windowMs - now) / 1000),
      );
      await this.ctx.storage.put(`bucket:${bucket}`, {
        stamps,
        extra: state.extra,
      });
      return { ok: false, retryAfterSec };
    }
    stamps.push(now);
    await this.ctx.storage.put(`bucket:${bucket}`, {
      stamps,
      extra: state.extra,
    });
    return { ok: true };
  }

  async addAllowance(bucket: string, extra: number): Promise<void> {
    const state = (await this.ctx.storage.get<Bucket>(`bucket:${bucket}`)) ?? {
      stamps: [],
      extra: 0,
    };
    state.extra += extra;
    await this.ctx.storage.put(`bucket:${bucket}`, state);
  }

  async rememberRecipient(
    email: string,
    day: string,
    limit: number,
  ): Promise<{ ok: boolean; count: number }> {
    const key = `recipients:${day}`;
    const current = (await this.ctx.storage.get<string[]>(key)) ?? [];
    if (current.includes(email)) return { ok: true, count: current.length };
    if (current.length >= limit) return { ok: false, count: current.length };
    current.push(email);
    await this.ctx.storage.put(key, current);
    return { ok: true, count: current.length };
  }

  async setFrozen(frozen: boolean): Promise<void> {
    await this.ctx.storage.put("frozen", frozen);
  }

  async isFrozen(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>("frozen")) === true;
  }

  async deliver(input: {
    frozen: boolean;
    globalFrozen: boolean;
    paused: boolean;
    payload: OutboundPayload;
    perDay: number;
    globalPerDay: number;
    checkGlobal: boolean;
  }): Promise<DeliverResult> {
    if (input.globalFrozen || input.frozen)
      return { ok: false, code: "frozen" };
    if (input.paused) return { ok: false, code: "paused" };
    const day = await this.consume(
      "sends-day",
      input.perDay,
      24 * 60 * 60 * 1000,
    );
    if (!day.ok)
      return {
        ok: false,
        code: "rate_limited",
        retryAfterSec: day.retryAfterSec,
      };
    if (input.checkGlobal) {
      const global = await this.consume(
        "sends-global",
        input.globalPerDay,
        24 * 60 * 60 * 1000,
      );
      if (!global.ok)
        return {
          ok: false,
          code: "rate_limited",
          retryAfterSec: global.retryAfterSec,
        };
    }
    for (const recipient of input.payload.to) {
      const minute = await this.consume(`rcpt-min:${recipient}`, 1, 60 * 1000);
      if (!minute.ok)
        return {
          ok: false,
          code: "rate_limited",
          retryAfterSec: minute.retryAfterSec,
        };
      const daily = await this.consume(
        `rcpt-day:${recipient}`,
        3,
        24 * 60 * 60 * 1000,
      );
      if (!daily.ok)
        return {
          ok: false,
          code: "rate_limited",
          retryAfterSec: daily.retryAfterSec,
        };
    }
    if (this.env.EMAIL_MODE === "record") {
      const messageId = `local_${crypto.randomUUID()}`;
      return { ok: true, messageId, internal: false };
    }
    try {
      const result = await this.env.EMAIL.send({
        from: input.payload.from,
        to: input.payload.to,
        cc: input.payload.cc.length > 0 ? input.payload.cc : undefined,
        subject: input.payload.subject,
        text: input.payload.text,
        html: input.payload.html,
        replyTo: input.payload.replyTo,
        headers: input.payload.headers,
      });
      return { ok: true, messageId: result.messageId, internal: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "send failed";
      if (message.includes("E_RECIPIENT_SUPPRESSED"))
        return { ok: false, code: "recipient_suppressed" };
      return { ok: false, code: "send_failed" };
    }
  }
}
