function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

export function mapAgentMailExport(doc, options) {
  const mailDomain = String(options.mailDomain ?? "").toLowerCase();
  const inboxes = [];
  const threads = [];
  const messages = [];
  const skipped = [];
  let n = 0;
  const id = (prefix) => `${prefix}_import_${String(++n).padStart(4, "0")}`;
  for (const inbox of doc.inboxes ?? []) {
    const address = String(inbox.inboxId ?? inbox.email ?? "").toLowerCase();
    if (!address.endsWith(`@${mailDomain}`)) {
      if (address) skipped.push(address);
      continue;
    }
    const slug = address.slice(0, address.indexOf("@"));
    inboxes.push({
      id: id("mbx"),
      slug: slug.split("+")[0],
      address,
      displayName: inbox.displayName ?? inbox.display_name ?? address,
    });
  }
  const byAddress = new Map(inboxes.map((inbox) => [inbox.address, inbox]));
  for (const thread of doc.threads ?? []) {
    const address = String(thread.inboxId ?? "").toLowerCase();
    const inbox = byAddress.get(address);
    if (!inbox) continue;
    const threadId = id("thd");
    const legacyThreadId = String(thread.threadId ?? thread.id ?? "");
    const subject = String(thread.subject ?? "(no subject)");
    const mappedThread = {
      id: threadId,
      legacyThreadId,
      inboxId: inbox.id,
      subject,
      messages: [],
    };
    for (const message of thread.messages ?? []) {
      const messageId = id("msg");
      mappedThread.messages.push(messageId);
      messages.push({
        id: messageId,
        threadId,
        mailboxId: inbox.id,
        from: String(
          message.from ?? message.from_addr ?? "unknown@example.com",
        ).toLowerCase(),
        subject: String(message.subject ?? subject),
        text: String(message.text ?? message.extractedText ?? ""),
        rfc: message.messageId ? String(message.messageId) : null,
        receivedAt: String(
          message.createdAt ?? message.timestamp ?? new Date(0).toISOString(),
        ),
      });
    }
    threads.push(mappedThread);
  }
  const now = new Date().toISOString();
  const sql = [];
  for (const inbox of inboxes) {
    sql.push(
      `INSERT INTO mailboxes (id, slug, domain, address, display_name, created_at, updated_at) VALUES (${sqlString(inbox.id)}, ${sqlString(inbox.slug)}, ${sqlString(mailDomain)}, ${sqlString(inbox.address)}, ${sqlString(inbox.displayName)}, ${sqlString(now)}, ${sqlString(now)}) ON CONFLICT(address) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at;`,
    );
  }
  for (const thread of threads) {
    const received =
      messages.find((message) => message.threadId === thread.id)?.receivedAt ??
      now;
    sql.push(
      `INSERT INTO threads (id, mailbox_id, subject, subject_norm, preview, last_message_at, legacy_thread_id, created_at) VALUES (${sqlString(thread.id)}, ${sqlString(thread.inboxId)}, ${sqlString(thread.subject)}, ${sqlString(thread.subject.toLowerCase())}, ${sqlString(thread.subject)}, ${sqlString(received)}, ${sqlString(thread.legacyThreadId)}, ${sqlString(now)});`,
    );
  }
  for (const message of messages) {
    sql.push(
      `INSERT INTO messages (id, thread_id, mailbox_id, direction, origin, rfc_message_id, from_addr, to_json, subject, text, preview, received_at, labels_json) VALUES (${sqlString(message.id)}, ${sqlString(message.threadId)}, ${sqlString(message.mailboxId)}, 'inbound', 'import', ${message.rfc ? sqlString(message.rfc) : "NULL"}, ${sqlString(message.from)}, '[]', ${sqlString(message.subject)}, ${sqlString(message.text)}, ${sqlString(message.text.slice(0, 160))}, ${sqlString(message.receivedAt)}, '["unread"]');`,
    );
  }
  return { inboxes, threads, messages, skipped, sql };
}

async function main() {
  const { readFile, mkdir, writeFile } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const fileFlag = args.indexOf("--file");
  const configFlag = args.indexOf("--config");
  const file = fileFlag >= 0 ? args[fileFlag + 1] : "";
  const configPath =
    configFlag >= 0 ? args[configFlag + 1] : "cf-agent-mail.config.json";
  if (!file) {
    console.error(
      "Usage: node bootstrap/import-agentmail.mjs --file export.json --config cf-agent-mail.config.json [--apply]",
    );
    process.exit(1);
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const { buildPlan } = await import("./plan.mjs");
  const plan = buildPlan(config);
  const mapped = mapAgentMailExport(JSON.parse(await readFile(file, "utf8")), {
    mailDomain: plan.mailDomain,
  });
  console.log(
    JSON.stringify(
      {
        dryRun: !apply,
        inboxes: mapped.inboxes.length,
        threads: mapped.threads.length,
        messages: mapped.messages.length,
        skipped: mapped.skipped,
      },
      null,
      2,
    ),
  );
  if (!apply) return;
  await mkdir("workers/api/.generated", { recursive: true });
  const sqlPath = "workers/api/.generated/agentmail-import.sql";
  await writeFile(sqlPath, mapped.sql.join("\n"));
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      plan.resources.d1,
      "--remote",
      "--file",
      sqlPath,
      "--config",
      "workers/api/.generated/wrangler.jsonc",
    ],
    {
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

const entry = globalThis.process?.argv?.[1] ?? "";
if (entry.endsWith("import-agentmail.mjs")) main();
