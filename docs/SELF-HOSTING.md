# Self-hosting cf-agent-mail

This guide takes a new Cloudflare account and a domain you control through a working agent mailbox. It uses `example.com` as the stand-in. Substitute your own zone, and do not commit the file that contains it.

You will create three Workers, one D1 database, two R2 buckets, and four Queues. Outbound mail uses Email Sending. Inbound mail uses Email Routing. The management console is for you. Agents use a mailbox token.

## Before you start

You need:

- A Cloudflare account on the Workers Paid plan. Email Sending to arbitrary recipients is a Paid feature. See the [pricing page](https://developers.cloudflare.com/email-service/platform/pricing/).
- A domain on Cloudflare DNS. Email Routing and Email Sending both write DNS records, and they can lock those records.
- Node.js 22 or newer, npm, Wrangler (installed by `npm ci` in this repo), and Terraform 1.6 or newer.
- `git`, and a checkout of this repository.

```bash
git clone <this-repo-url>
cd cf-agent-mail
npm ci
cp cf-agent-mail.config.example.json cf-agent-mail.config.json
```

Edit `cf-agent-mail.config.json`. It is gitignored.

| Field | Example | Meaning |
| --- | --- | --- |
| `account_id` | your account id | Dashboard, Workers overview, account id. |
| `zone_id` | your zone id | The zone you are about to dedicate to mail. |
| `zone_name` | `mail.example.com` | That zone's apex. |
| `mail_subdomain` | `@` | `@` means addresses live on the zone apex: `surveys@mail.example.com`. |
| `system_subdomain` | `login` | Template mail comes from `login@login.mail.example.com` in this layout. |
| `api_subdomain` | `relay` | The console and API host: `relay.mail.example.com`. |
| `owner_email` | `owner@example.com` | The only addresses that may receive template mail, comma-separated if you edit the var later. |
| `mailbox_slugs` | `["surveys"]` | One Email Routing rule per slug. |
| `enable_email_sending` | `false` | Leave false for the first dry run. |
| `enable_routing` | `false` | Leave false for the first dry run. |

`enable_email_sending` and `enable_routing` default to false so Terraform does not touch mail until you opt in. You can also onboard both products in the dashboard and leave the flags false. Pick one place to turn them on, not both, or you will fight over the same settings.

### The MX warning

Email Routing's onboarding publishes MX at the **apex of the zone you select**, plus an SPF TXT record on that same name. The official setup is documented under [Email Service domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/). Those records replace existing MX for the whole zone.

If `example.com` already receives mail, do not enable Email Routing on the `example.com` zone. Mail to `you@example.com` can start flowing to Cloudflare and disappear from your current host.

Do this instead:

1. In the parent zone `example.com`, add NS records that delegate `mail.example.com` to Cloudflare.
2. Add `mail.example.com` as its own zone in the same account.
3. Set `zone_name` to `mail.example.com` and `mail_subdomain` to `@`.
4. Confirm the parent zone's MX records are unchanged before you continue.

A brand-new domain you do not use for anything else is the same idea. The dry run prints this warning again. Read it against your real zone name.

## 1. Dry run

```bash
./bootstrap/onboard.sh --config cf-agent-mail.config.json
```

This prints JSON and exits. It does not call Cloudflare and it does not send mail. Check:

- `addresses` lists only the mailboxes you asked for, on the hostname you asked for.
- `warnings` mentions MX.
- `dns` lists records Cloudflare will create. You do not type these in by hand, and you do not put them in Terraform. Terraform in this repo refuses to manage those locked records.
- `enable_routing` and `enable_email_sending` are still false unless you chose otherwise.

If the plan names a zone that already has mail, stop and fix the config.

## 2. DNS records you should see

After you onboard the products, the dashboard creates and often locks these records. Names below assume the zone apex is `mail.example.com`. On a zone named `example.com` the routing records land on `example.com`, which is the case the warning is about.

Routing, on the zone apex ([routing DNS records](https://developers.cloudflare.com/email-routing/setup/email-routing-dns-records/)):

| Type | Name | Value |
| --- | --- | --- |
| MX | `mail.example.com` | `route1.mx.cloudflare.net` |
| MX | `mail.example.com` | `route2.mx.cloudflare.net` |
| MX | `mail.example.com` | `route3.mx.cloudflare.net` |
| TXT | `mail.example.com` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| TXT | `cf2024-1._domainkey.mail.example.com` | DKIM key published by Email Routing |

Sending, under `cf-bounce` ([sending DNS records](https://developers.cloudflare.com/email-service/configuration/domains/)):

| Type | Name | Value |
| --- | --- | --- |
| MX | `cf-bounce.mail.example.com` | Cloudflare MX hosts |
| TXT | `cf-bounce.mail.example.com` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| TXT | `cf-bounce._domainkey.mail.example.com` | DKIM key published by Email Sending |
| TXT | `_dmarc.mail.example.com` | `v=DMARC1; p=none` to start |

Repeat the sending set for the system hostname if template mail uses a different name, such as `login.mail.example.com`.

Start DMARC at `p=none`. Move to `p=reject` after real mail authenticates. If an SPF record already exists, merge the `include:` into that record. Two SPF TXT records on one name fail authentication.

Priorities on the MX records are assigned by Cloudflare. Accept the values the wizard shows.

In Email Routing settings, enable subaddressing (plus addresses). Reply tags look like `surveys+t.<thread id>.<hmac>@mail.example.com`. Without subaddressing, those replies do not hit the `surveys@` rule. There is no subdomain catch-all. Each slug needs its own literal address.

## 3. Onboard Email Routing and Email Sending

In the dashboard:

1. Compute, Email Service, Email Routing. Onboard the dedicated zone. Read the DNS diff. Confirm it does not mention a zone that already receives mail.
2. Compute, Email Service, Email Sending. Onboard the same zone, and the system hostname if it is a different name inside that zone. Workers Paid has to be active or onboarding to arbitrary recipients is refused.
3. Leave the flags in the config false if you did this in the dashboard.

To let Terraform create the sending subdomain and the routing settings object instead, set `enable_email_sending` and `enable_routing` to `true` and run the dry run again. Routing rules are still not in Terraform. The inbound Worker's `addresses` array is the rule list. Wrangler reconciles it on deploy. That avoids two tools editing the same rules.

## 4. Create resources and deploy

```bash
./bootstrap/onboard.sh --config cf-agent-mail.config.json --apply
```

The script:

1. Refuses to continue if `account_id` or `zone_id` still contains `YOUR_`.
2. Writes `infra/terraform/terraform.tfvars.json` (gitignored) and `workers/*/.generated/wrangler.jsonc` (gitignored).
3. Runs `terraform init` and `terraform apply` for D1, two R2 buckets, and four Queues. Email resources are included only when the flags are true.
4. Deploys `cf-agent-mail-inbound`, `cf-agent-mail-processor`, and `cf-agent-mail-api`.
5. Applies `migrations/` to the remote D1 database.
6. Inserts one mailbox row per slug.
7. Prints `wrangler secret put` commands. It does not print secret values.

The root `wrangler.jsonc` is not deployed. It is the local test config. `EMAIL_MODE=record` in that file journals outbound mail so tests never call Email Sending.

You can do the same steps by hand:

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# replace YOUR_ACCOUNT_ID and YOUR_ZONE_ID, then:
terraform init
terraform plan
terraform apply
```

Copy `d1_database_id` from the output into the three generated Wrangler files, replacing `YOUR_D1_DATABASE_ID`. Then:

```bash
npx wrangler deploy --config workers/inbound/.generated/wrangler.jsonc
npx wrangler deploy --config workers/processor/.generated/wrangler.jsonc
npx wrangler deploy --config workers/api/.generated/wrangler.jsonc
npx wrangler d1 migrations apply cf-agent-mail --remote --config workers/api/.generated/wrangler.jsonc
```

The API Worker gets a custom domain at the API host, for example `relay.mail.example.com`. That creates a proxied DNS record for the API. It does not create MX.

Adding a mailbox later means adding the slug to the config, redeploying the inbound Worker so the `addresses` list gains a rule, and inserting the mailbox row. The API can create the row (`POST /v1/inboxes`, owner token) but it cannot edit Email Routing rules, because the Worker does not hold a Cloudflare API token. The response includes `routingRequired: true` until you redeploy.

## 5. Secrets

Generate three values and store them somewhere you already keep secrets. Then pipe them. Do not pass them as command arguments.

```bash
printf '%s' "$TOKEN_PEPPER" | npx wrangler secret put TOKEN_PEPPER --config workers/api/.generated/wrangler.jsonc
printf '%s' "$REPLY_HMAC_KEY" | npx wrangler secret put REPLY_HMAC_KEY --config workers/api/.generated/wrangler.jsonc
printf '%s' "$WEBHOOK_SIGNING_KEY" | npx wrangler secret put WEBHOOK_SIGNING_KEY --config workers/api/.generated/wrangler.jsonc
```

Repeat for `workers/processor/.generated/wrangler.jsonc` and `workers/inbound/.generated/wrangler.jsonc`. The apply script prints the full set.

`TOKEN_PEPPER` hashes API tokens. `REPLY_HMAC_KEY` signs reply tags. `WEBHOOK_SIGNING_KEY` signs wake callbacks and the provider-event ingest.

`OWNER_ALLOWLIST` is a var, not a secret. It is the owner addresses that may receive template mail. Change it in the generated Wrangler config and redeploy, or edit the var before apply.

Leave `ENFORCE_KNOWN_AUTO` as `false`.

## 6. Lock the console with Access

Create a Cloudflare Access application for `relay.mail.example.com` with a path policy of `/admin`. Allow only your owner email. Leave `/v1`, `/mcp`, and `/health` off the Access policy. Those routes use the mailbox token. If Access covers the whole hostname, the agent cannot connect.

Set these vars on the API Worker and redeploy:

- `ACCESS_TEAM_DOMAIN`: your team domain, such as `your-team.cloudflareaccess.com`.
- `ACCESS_AUD`: the application's audience tag.
- `AUTH_MODE`: `access` if you want the console to prefer Access. An owner bearer token still works, which is how you mint the first session.

The console also accepts an owner token pasted into the sign-in form. The token is stored in an HttpOnly cookie named `cfam_owner`. Forms include a CSRF token. The page has a strict Content-Security-Policy and no third-party scripts.

You can skip Access and use only the owner token. Do not expose the console on the open internet without one of those two.

## 7. First mailbox and agent token

The seed SQL inserted the mailbox rows. Open `https://relay.mail.example.com/admin`.

1. Sign in with Access, or paste an owner token. To mint the first owner token before the console cookie exists, insert a row with `bootstrap` locally is not required: use Wrangler to insert a token hash, or sign in with Access first. The Access path needs no token. The token path needs a hash in D1.

   From a machine that already has `TOKEN_PEPPER`:

   ```bash
   node --input-type=module -e "
   const pepper = process.env.TOKEN_PEPPER;
   const token = 'cam_' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
   const bytes = new TextEncoder().encode(pepper + ':' + token);
   const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
   console.log('TOKEN ' + token);
   console.log('HASH ' + digest);
   "
   ```

   Put `HASH` in D1. Do not put `TOKEN` in the SQL file you commit.

   ```sql
   INSERT INTO tokens (id, class, label, scopes_json, hash, created_at)
   VALUES ('tok_owner', 'owner', 'owner', '["admin"]', '<HASH>', datetime('now'));
   ```

   ```bash
   npx wrangler d1 execute cf-agent-mail --remote --config workers/api/.generated/wrangler.jsonc --command "INSERT INTO tokens (id, class, label, scopes_json, hash, created_at) VALUES ('tok_owner', 'owner', 'owner', '[\"admin\"]', '<HASH>', datetime('now'));"
   ```

2. Sign in, open Tokens, and create an agent token for `surveys@mail.example.com`. Copy it once. It is stored as a peppered SHA-256 hash. Scopes are `mail:read`, `mail:search`, `mail:draft`, `mail:request-send`, `mail:write`, and `wake`, each limited to that address.
3. Give the agent the token and the base URL `https://relay.mail.example.com`. The MCP endpoint is `https://relay.mail.example.com/mcp`. The agent sends `Authorization: Bearer <token>` or `x-api-key`.

Check health:

```bash
curl -sS https://relay.mail.example.com/health
```

You want `{"ok":true}`.

## 8. Test receive and send

Receive: from a normal mailbox, send a short message to `surveys@mail.example.com`. Within a minute it should appear in the console search. The agent can list it:

```bash
curl -sS -H "Authorization: Bearer $AGENT_TOKEN" \
  "https://relay.mail.example.com/v1/inboxes/surveys%40mail.example.com/messages"
```

If the message looks like an instruction to the agent, it is quarantined. The agent list stays empty. You release it from Review.

Send: ask the agent to send, or:

```bash
curl -sS -X POST -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "content-type: application/json" \
  -d '{"to":["vendor@example.com"],"subject":"Hello","text":"A short note."}' \
  "https://relay.mail.example.com/v1/inboxes/surveys%40mail.example.com/messages/send"
```

The response is HTTP 202 with `"status":"pending_review"`, a `reviewId`, and a `contentHash`. Nothing has been sent. Open Review, read the text, and approve. Approval sends only when the hash matches the stored draft. Rejecting drops it. Freeze, on the overview page, makes approval return HTTP 423.

Template mail is the exception:

```bash
curl -sS -X POST -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"otp","to":"owner@example.com","variables":{"code":"123456"}}' \
  https://relay.mail.example.com/v1/system/send
```

The code must be 6 digits. The recipient must be on `OWNER_ALLOWLIST`. An agent token without `system:send:otp` is refused.

Bounces and complaints can be posted to `/v1/provider/events` with header `x-cf-agent-mail-signature: sha256=<hmac of the raw body>` using `WEBHOOK_SIGNING_KEY`, or with the owner token. A hard bounce or complaint adds a suppression. Three of them pause that mailbox.

## 9. Retention, audit, and the kill switch

Defaults, per mailbox: raw objects 90 days, parsed messages 365 days, audit rows 730 days, drafts 30 days. Quarantine expires after 14 days. The parsed row is deleted. The raw object follows the raw retention. A thread with `hold` set is skipped. Change message retention under Retention in the console.

The audit log records actor, action, and result. It does not store bodies. Download it as CSV from the audit page.

Freeze stops the Durable Object from accepting sends, including template mail.

## 10. Migrate from AgentMail

Export threads from AgentMail to a JSON file on your machine. This repo does not call AgentMail and does not delete the old inboxes. A shape that imports cleanly:

```json
{
  "inboxes": [{ "inboxId": "surveys@mail.example.com", "displayName": "Surveys" }],
  "threads": [{
    "threadId": "the-agentmail-thread-id",
    "inboxId": "surveys@mail.example.com",
    "subject": "Hello",
    "messages": [{
      "messageId": "<m@example.com>",
      "from": "vendor@example.com",
      "text": "Hi",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }]
  }]
}
```

Addresses have to be on your mail hostname. Anything else is skipped and listed.

```bash
node bootstrap/import-agentmail.mjs --file export.json --config cf-agent-mail.config.json
```

That is a dry run. It prints counts. When the counts match the export:

```bash
node bootstrap/import-agentmail.mjs --file export.json --config cf-agent-mail.config.json --apply
```

`--apply` writes SQL and runs `wrangler d1 execute`. Each thread stores AgentMail's id in `threads.legacy_thread_id`. Point the agent at the new MCP URL and a new token. Keep the AgentMail inboxes until you have compared a few threads by hand. Do not delete them as part of this import.

## Troubleshooting

**Mail to my existing domain stopped.** Routing was enabled on a zone that already had MX. In that zone's DNS history, restore the previous MX and remove the routing MX if you did not mean to move the mail. Then delegate a dedicated zone and start again. This project cannot undo that for you.

**The dry run looks right but apply says YOUR_.** `account_id` or `zone_id` still has the placeholder. Edit the config. The example file is supposed to fail this check.

**Deploy of the root wrangler.jsonc.** Do not. It uses local database ids and `EMAIL_MODE=record`, so production would journal mail instead of sending it, and it would not match your account.

**Inbound mail never arrives.** Confirm the inbound Worker deployed with `addresses` containing the exact recipient, routing status is `ready`, MX is on the dedicated zone, and the mailbox row exists and is enabled. Unknown recipients are rejected on purpose. A disabled mailbox is rejected too.

**Replies to the plus-address bounce.** Turn on subaddressing for the zone.

**Agent send returns pending_review.** That is the default. Approve it in the console. A 409 on approve means the hash does not match the draft, often because the draft was edited. A 423 means the kill switch or the mailbox freeze is on.

**Agent gets 403 on another inbox.** The token is scoped to one address. Create another token or use the owner token. Agents cannot widen allow lists.

**System mail to a vendor is refused.** Template mail only goes to `OWNER_ALLOWLIST`.

**DKIM or SPF fails.** Wait for DNS, then check `cf-bounce._domainkey.<mail-host>` and the SPF TXT on `cf-bounce.<mail-host>`. Two SPF records on one name will fail.

**Access blocks the agent.** The Access policy is covering `/mcp` or `/v1`. Limit it to `/admin`.

**Queue backlog.** The processor Worker has to be deployed. It owns the consumers for parse, events, and wake. The dead-letter queue is `<prefix>-dlq`.

## Local tests

```bash
npm test
```

Tests use Miniflare and `EMAIL_MODE=record`. They do not send email and they do not need your Cloudflare account.
