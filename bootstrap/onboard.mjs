import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildPlan, hasPlaceholder, renderWrangler } from "./plan.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const configFlag = args.indexOf("--config");
const configPath =
  configFlag >= 0 ? args[configFlag + 1] : "cf-agent-mail.config.json";

const config = JSON.parse(await readFile(configPath, "utf8"));
const plan = buildPlan(config);
console.log(JSON.stringify({ dryRun: !apply, ...publicPlan(plan) }, null, 2));

if (!apply) {
  console.log(
    "\nDry run only. Re-run with --apply after the plan looks right. This script never sends email.",
  );
  process.exit(0);
}
if (hasPlaceholder(plan.config)) {
  console.error(
    "Refusing to apply while account_id or zone_id still contains YOUR_.",
  );
  process.exit(1);
}

await mkdir("infra/terraform", { recursive: true });
await mkdir("workers/inbound/.generated", { recursive: true });
await mkdir("workers/processor/.generated", { recursive: true });
await mkdir("workers/api/.generated", { recursive: true });

const tfvars = {
  account_id: plan.config.account_id,
  zone_id: plan.config.zone_id,
  resource_prefix: plan.config.resource_prefix,
  mail_hostname: plan.mailDomain,
  system_hostname: plan.systemDomain,
  enable_email_sending: plan.config.enable_email_sending,
  enable_routing: plan.config.enable_routing,
};
await writeFile(
  "infra/terraform/terraform.tfvars.json",
  `${JSON.stringify(tfvars, null, 2)}\n`,
);
await writeFile(
  "workers/inbound/.generated/wrangler.jsonc",
  renderWrangler("inbound", plan),
);
await writeFile(
  "workers/processor/.generated/wrangler.jsonc",
  renderWrangler("processor", plan),
);
await writeFile(
  "workers/api/.generated/wrangler.jsonc",
  renderWrangler("api", plan),
);

run("terraform", ["-chdir=infra/terraform", "init"]);
run("terraform", ["-chdir=infra/terraform", "apply", "-auto-approve"]);
const output = spawnSync(
  "terraform",
  ["-chdir=infra/terraform", "output", "-raw", "d1_database_id"],
  { encoding: "utf8" },
);
if (output.status !== 0) process.exit(output.status ?? 1);
const databaseId = output.stdout.trim();
for (const kind of ["inbound", "processor", "api"]) {
  const path = `workers/${kind}/.generated/wrangler.jsonc`;
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replaceAll("YOUR_D1_DATABASE_ID", databaseId));
  run("npx", ["wrangler", "deploy", "--config", path]);
}
run("npx", [
  "wrangler",
  "d1",
  "migrations",
  "apply",
  plan.resources.d1,
  "--remote",
  "--config",
  "workers/api/.generated/wrangler.jsonc",
]);
await writeSeed(plan);
console.log(
  "\nSet secrets by piping them. Do not put them in the shell history as arguments:",
);
for (const name of plan.secrets) {
  console.log(
    `printf '%s' "$${name}" | npx wrangler secret put ${name} --config workers/api/.generated/wrangler.jsonc`,
  );
  console.log(
    `printf '%s' "$${name}" | npx wrangler secret put ${name} --config workers/processor/.generated/wrangler.jsonc`,
  );
  console.log(
    `printf '%s' "$${name}" | npx wrangler secret put ${name} --config workers/inbound/.generated/wrangler.jsonc`,
  );
}
for (const name of plan.secrets) {
  if (process.env[name]) putSecret(name, process.env[name]);
}
console.log(
  "\nApplied resources and deployed Workers. No email was sent. Create the first token in the management console.",
);

function publicPlan(plan) {
  return {
    mailDomain: plan.mailDomain,
    systemDomain: plan.systemDomain,
    systemFrom: plan.systemFrom,
    apiHost: plan.apiHost,
    ownerEmail: plan.ownerEmail,
    addresses: plan.addresses,
    resources: plan.resources,
    dns: plan.dns,
    warnings: plan.warnings,
    secrets: plan.secrets,
    steps: plan.steps,
    enable_email_sending: plan.config.enable_email_sending,
    enable_routing: plan.config.enable_routing,
  };
}

async function writeSeed(plan) {
  const lines = [];
  plan.config.mailbox_slugs.forEach((slug, index) => {
    const address = plan.addresses[index];
    lines.push(
      `INSERT INTO mailboxes (id, slug, domain, address, display_name, created_at, updated_at) VALUES ('mbx_seed_${slug}', '${slug}', '${plan.mailDomain}', '${address}', '${slug}', datetime('now'), datetime('now')) ON CONFLICT(address) DO NOTHING;`,
    );
  });
  const path = "workers/api/.generated/seed.sql";
  await writeFile(path, lines.join("\n"));
  run("npx", [
    "wrangler",
    "d1",
    "execute",
    plan.resources.d1,
    "--remote",
    "--file",
    path,
    "--config",
    "workers/api/.generated/wrangler.jsonc",
  ]);
}

function putSecret(name, value) {
  for (const kind of ["api", "processor", "inbound"]) {
    const result = spawnSync(
      "npx",
      [
        "wrangler",
        "secret",
        "put",
        name,
        "--config",
        `workers/${kind}/.generated/wrangler.jsonc`,
      ],
      {
        input: value,
        encoding: "utf8",
      },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
