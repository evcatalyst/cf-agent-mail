# Bootstrap prompt: OpenAI Codex

Paste the prompt below into a Codex agent with this repository as its workspace. The agent sets the instance up. You still supply the Cloudflare account, the domain, and every approval.

---

Set up cf-agent-mail in this workspace for the human operator. Read `README.md`, `docs/SELF-HOSTING.md`, and `SECURITY.md` before changing anything. This repo is a reusable pattern. Do not hardcode an account id, zone, or domain. Use `example.com` only as documentation. The operator's real values belong in the gitignored `cf-agent-mail.config.json`.

Operate in this order, and wait for the operator when a step needs them:

1. Ask for: Cloudflare account id, zone id, zone name, mail subdomain (use `@` when the zone apex is the mail host), system subdomain, API subdomain, owner email, and mailbox slugs. Ask them to confirm, in writing, that enabling Email Routing on that zone will not break existing mail. Routing MX is published at the zone apex. If they already receive mail there, stop. Recommend delegating a dedicated zone such as `mail.example.com`.
2. Copy the example config and fill it with those values. Run `./bootstrap/onboard.sh --config cf-agent-mail.config.json` without `--apply`. Show the JSON plan, including warnings and DNS records. Stop until the operator accepts it.
3. On acceptance, run `./bootstrap/onboard.sh --config cf-agent-mail.config.json --apply`. If Terraform or Wrangler is missing, install the documented version and show the operator the command before you run it. Do not deploy the root `wrangler.jsonc`. Do not set `send_email.remote` to true.
4. Secrets: `TOKEN_PEPPER`, `REPLY_HMAC_KEY`, `WEBHOOK_SIGNING_KEY`. Generate them locally with `openssl rand -base64 32` if the operator asks. Pipe them into `wrangler secret put`. Never echo a secret, never commit one, and never send one over email.
5. Ask the operator to create a Cloudflare Access application for `https://<api-host>/admin` and to add their email to the allow list. You cannot complete Access login for them. Do not put Access in front of `/mcp` or `/v1`, or the agent will be locked out.
6. Confirm `GET /health` returns `{"ok":true}`. Confirm the mailbox rows exist. Mint an owner token and one agent token scoped to a single mailbox. The token is shown once.
7. Verification that does not send mail: from the agent token, call `send_message` or `POST /v1/inboxes/<address>/messages/send` to a recipient the operator names. The response must be `pending_review`. Confirm `outbound_attempts` has no row for that draft. Stop. Tell the operator the review id and content hash. Send only if they approve that hash in the console themselves.
8. Template mail such as an OTP is the one path that can leave without review, and only to the owner allow list. Do not call `/v1/system/send` unless the operator asks for a specific code to their own address.
9. Never delete an existing AgentMail inbox as part of migration. A dry run of `bootstrap/import-agentmail.mjs` comes first. `--apply` only after the operator compares the counts.

If any command would change MX on a zone the operator did not dedicate to this project, do not run it. If any command would send email, do not run it. Report the exact next command and wait.
