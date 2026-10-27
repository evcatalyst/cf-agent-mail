const REQUIRED = [
  "account_id",
  "zone_id",
  "zone_name",
  "owner_email",
  "mailbox_slugs",
  "resource_prefix",
];

export function buildPlan(input) {
  const config = normalize(input);
  const problems = validate(config);
  if (problems.length > 0) {
    const error = new Error(problems.join("; "));
    error.problems = problems;
    throw error;
  }
  const mailDomain = joinHost(config.mail_subdomain, config.zone_name);
  const systemDomain = joinHost(config.system_subdomain, config.zone_name);
  const apiHost = joinHost(config.api_subdomain, config.zone_name);
  const prefix = config.resource_prefix;
  const addresses = config.mailbox_slugs.map((slug) => `${slug}@${mailDomain}`);
  const resources = {
    d1: prefix,
    r2: [`${prefix}-raw`, `${prefix}-att`],
    queues: [
      `${prefix}-parse`,
      `${prefix}-events`,
      `${prefix}-wake`,
      `${prefix}-dlq`,
    ],
  };
  const dns = expectedDns(config.zone_name, mailDomain, systemDomain);
  const warnings = [
    `Email Routing on zone ${config.zone_name} publishes MX at that zone's apex and can replace mail that already arrives there. Use a zone that does not already receive mail. Delegating ${mailDomain} as its own zone, with mail_subdomain set to @, keeps the parent zone's MX unchanged.`,
    "Do not edit DNS records that Email Routing or Email Sending locks. This plan only lists the records those products create.",
    "Dry run is the default. --apply creates resources and deploys Workers. It never sends email.",
  ];
  const workers = {
    inbound: workerConfig("inbound", config, {
      mailDomain,
      systemDomain,
      apiHost,
      addresses,
      resources,
    }),
    processor: workerConfig("processor", config, {
      mailDomain,
      systemDomain,
      apiHost,
      addresses,
      resources,
    }),
    api: workerConfig("api", config, {
      mailDomain,
      systemDomain,
      apiHost,
      addresses,
      resources,
    }),
  };
  return {
    dryRunDefault: true,
    sendsEmail: false,
    config,
    mailDomain,
    systemDomain,
    systemFrom: `login@${systemDomain}`,
    apiHost,
    ownerEmail: config.owner_email,
    addresses,
    resources,
    dns,
    warnings,
    secrets: ["TOKEN_PEPPER", "REPLY_HMAC_KEY", "WEBHOOK_SIGNING_KEY"],
    workers,
    steps: [
      "Confirm the zone does not already receive mail you need to keep.",
      "Run bootstrap/onboard.sh with no --apply and read the plan.",
      "Onboard Email Routing and Email Sending in the Cloudflare dashboard for that zone, or set the terraform flags and apply.",
      "Run bootstrap/onboard.sh --apply.",
      "Set the three Worker secrets with wrangler secret put. Do not pass secret values as arguments.",
      "Put Cloudflare Access in front of the management console.",
      "Create an owner token and an agent token in the console. Give the agent only its mailbox.",
      "Send a message to the mailbox from outside, then ask the agent to send. Confirm the send stays pending until you approve it.",
    ],
  };
}

export function renderWrangler(kind, plan, depth = 3) {
  const copy = structuredClone(plan.workers[kind]);
  const prefix = "../".repeat(depth);
  copy.$schema = `${prefix}node_modules/wrangler/config-schema.json`;
  copy.main = `${prefix}src/entry-${kind}.ts`;
  copy.d1_databases[0].migrations_dir = `${prefix}migrations`;
  return `// Generated from your config. Do not put secrets in this file.\n${JSON.stringify(copy, null, 2)}\n`;
}

export function hasPlaceholder(config) {
  const blob = `${config.account_id} ${config.zone_id}`;
  return blob.includes("YOUR_");
}

function workerConfig(kind, config, ctx) {
  const name = `${config.resource_prefix}-${kind}`;
  const depth = "../".repeat(3);
  const base = {
    $schema: `${depth}node_modules/wrangler/config-schema.json`,
    name,
    main: `${depth}src/entry-${kind}.ts`,
    compatibility_date: "2026-10-27",
    compatibility_flags: ["nodejs_compat"],
    account_id: config.account_id,
    workers_dev: false,
    observability: { enabled: true, traces: { enabled: true } },
    vars: vars(config, ctx),
    d1_databases: [
      {
        binding: "DB",
        database_name: ctx.resources.d1,
        database_id: "YOUR_D1_DATABASE_ID",
        migrations_dir: `${depth}migrations`,
      },
    ],
    r2_buckets: [
      { binding: "RAW", bucket_name: ctx.resources.r2[0] },
      { binding: "ATTACHMENTS", bucket_name: ctx.resources.r2[1] },
    ],
  };
  if (kind === "inbound") {
    return {
      ...base,
      addresses: ctx.addresses,
      queues: { producers: producers(ctx.resources, ["PARSE_QUEUE"]) },
    };
  }
  if (kind === "processor") {
    return {
      ...base,
      triggers: { crons: ["15 4 * * *"] },
      queues: {
        producers: producers(ctx.resources, ["WAKE_QUEUE", "DLQ"]),
        consumers: ["parse", "events", "wake"].map((suffix) => ({
          queue: `${config.resource_prefix}-${suffix}`,
          max_batch_size: 10,
          max_retries: 3,
          dead_letter_queue: `${config.resource_prefix}-dlq`,
        })),
      },
    };
  }
  return {
    ...base,
    routes: [{ pattern: ctx.apiHost, custom_domain: true }],
    send_email: [{ name: "EMAIL" }],
    durable_objects: { bindings: [{ name: "MAILBOX", class_name: "Mailbox" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Mailbox"] }],
    queues: {
      producers: producers(ctx.resources, ["WAKE_QUEUE", "EVENTS_QUEUE"]),
    },
  };
}

function producers(resources, bindings) {
  const names = {
    PARSE_QUEUE: resources.queues[0],
    EVENTS_QUEUE: resources.queues[1],
    WAKE_QUEUE: resources.queues[2],
    DLQ: resources.queues[3],
  };
  return bindings.map((binding) => ({ binding, queue: names[binding] }));
}

function vars(config, ctx) {
  return {
    MAIL_DOMAIN: ctx.mailDomain,
    SYSTEM_DOMAIN: ctx.systemDomain,
    SYSTEM_FROM: `login@${ctx.systemDomain}`,
    OWNER_ALLOWLIST: config.owner_email,
    PUBLIC_BASE_URL: `https://${ctx.apiHost}`,
    AUTH_MODE: "token",
    PARSE_MAX_BYTES: "10485760",
    ENFORCE_KNOWN_AUTO: "false",
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
  };
}

function expectedDns(zoneName, mailDomain, systemDomain) {
  const routing = [
    {
      managedBy: "cloudflare-email-routing",
      type: "MX",
      name: zoneName,
      value: "route1.mx.cloudflare.net",
    },
    {
      managedBy: "cloudflare-email-routing",
      type: "MX",
      name: zoneName,
      value: "route2.mx.cloudflare.net",
    },
    {
      managedBy: "cloudflare-email-routing",
      type: "MX",
      name: zoneName,
      value: "route3.mx.cloudflare.net",
    },
    {
      managedBy: "cloudflare-email-routing",
      type: "TXT",
      name: zoneName,
      value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
    },
    {
      managedBy: "cloudflare-email-routing",
      type: "TXT",
      name: `cf2024-1._domainkey.${zoneName}`,
      value: "DKIM public key published by Email Routing",
    },
  ];
  const sending = [mailDomain, systemDomain].flatMap((domain) => [
    {
      managedBy: "cloudflare-email-sending",
      type: "MX",
      name: `cf-bounce.${domain}`,
      value: "route1.mx.cloudflare.net",
    },
    {
      managedBy: "cloudflare-email-sending",
      type: "MX",
      name: `cf-bounce.${domain}`,
      value: "route2.mx.cloudflare.net",
    },
    {
      managedBy: "cloudflare-email-sending",
      type: "MX",
      name: `cf-bounce.${domain}`,
      value: "route3.mx.cloudflare.net",
    },
    {
      managedBy: "cloudflare-email-sending",
      type: "TXT",
      name: `cf-bounce.${domain}`,
      value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
    },
    {
      managedBy: "cloudflare-email-sending",
      type: "TXT",
      name: `cf-bounce._domainkey.${domain}`,
      value: "DKIM public key published by Email Sending",
    },
    {
      managedBy: "cloudflare-email-sending",
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: "v=DMARC1; p=none",
    },
  ]);
  return [...routing, ...sending];
}

function normalize(input) {
  return {
    account_id: String(input.account_id ?? "").trim(),
    zone_id: String(input.zone_id ?? "").trim(),
    zone_name: String(input.zone_name ?? "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, ""),
    mail_subdomain: String(input.mail_subdomain ?? "")
      .trim()
      .toLowerCase(),
    system_subdomain: String(input.system_subdomain ?? "login")
      .trim()
      .toLowerCase(),
    api_subdomain: String(input.api_subdomain ?? "relay")
      .trim()
      .toLowerCase(),
    owner_email: String(input.owner_email ?? "")
      .trim()
      .toLowerCase(),
    mailbox_slugs: Array.isArray(input.mailbox_slugs)
      ? input.mailbox_slugs.map((slug) => String(slug).trim().toLowerCase())
      : [],
    resource_prefix: String(input.resource_prefix ?? "cf-agent-mail").trim(),
    enable_email_sending: input.enable_email_sending === true,
    enable_routing: input.enable_routing === true,
    enable_access: input.enable_access === true,
  };
}

function validate(config) {
  const problems = [];
  for (const key of REQUIRED) {
    const value = config[key];
    if (
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    )
      problems.push(`${key} is required`);
  }
  if (config.zone_name && !/^[a-z0-9.-]+$/.test(config.zone_name))
    problems.push("zone_name must be a hostname");
  if (config.owner_email && !config.owner_email.includes("@"))
    problems.push("owner_email must be an email address");
  for (const slug of config.mailbox_slugs) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug))
      problems.push(`mailbox slug ${slug} is invalid`);
  }
  if (
    config.resource_prefix &&
    !/^[a-z0-9][a-z0-9-]{0,40}$/.test(config.resource_prefix)
  )
    problems.push("resource_prefix is invalid");
  return problems;
}

function joinHost(label, zone) {
  if (!label || label === "@") return zone;
  return `${label}.${zone}`;
}
