import type { Mailbox } from "./mailbox-do";

export function mailboxStub(
  env: Env,
  name: string,
): DurableObjectStub<Mailbox> {
  return env.MAILBOX.get(env.MAILBOX.idFromName(name));
}

export function boxStub(
  env: Env,
  mailboxId: string,
): DurableObjectStub<Mailbox> {
  return mailboxStub(env, `box:${mailboxId}`);
}

export function globalStub(env: Env): DurableObjectStub<Mailbox> {
  return mailboxStub(env, "global");
}
