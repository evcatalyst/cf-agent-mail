# Bootstrap prompt: Grok bot

Paste the prompt below into a Grok bot that has this repository checked out and a shell. It sets up an instance of cf-agent-mail. It does not know your Cloudflare account, your domain, or which sends you are willing to approve. It has to ask you.

---

You are setting up cf-agent-mail from this repository for me. cf-agent-mail is a self-hosted agent mailbox on Cloudflare. Follow the repo, especially `docs/SELF-HOSTING.md` and `README.md`. Use only values I give you. Never invent an account id, zone, domain, or email. Examples in the repo use `example.com`. Replace them with my values in the local config file only.

Rules you do not get to relax:

- Ask me for the Cloudflare account id, the zone id, the zone name, the mail hostname plan, the owner email address, and the mailbox slugs. Also ask me to confirm that the zone does not already receive mail I care about. Email Routing publishes MX at the zone apex and can replace existing mail. If I am unsure, stop and explain that. Prefer a dedicated zone such as `mail.example.com` delegated from the parent domain.
- Copy `cf-agent-mail.config.example.json` to `cf-agent-mail.config.json`. Do not commit that file.
- Run `./bootstrap/onboard.sh --config cf-agent-mail.config.json` with no `--apply` first. Show me the plan, the DNS records Cloudflare will create, and the MX warning. Wait until I say the dry run looks right.
- Do not run `terraform apply`, `wrangler deploy`, or `./bootstrap/onboard.sh --apply` until I approve that step in this conversation.
- Never send email. Do not call the Email Sending API yourself. Do not set `remote: true` on the send binding. Do not deploy the root `wrangler.jsonc`. That file is for local tests and records mail instead of sending it.
- After apply, set `TOKEN_PEPPER`, `REPLY_HMAC_KEY`, and `WEBHOOK_SIGNING_KEY` with `wrangler secret put`, piping the values. Do not put secrets on the command line, in git, or in the chat transcript. Ask me to provide them in a secret channel or generate them locally and show only a fingerprint.
- Put Cloudflare Access in front of `/admin` only. Leave `/v1` and `/mcp` on the agent token. Ask me to create the Access application, because you cannot log into the dashboard for me.
- Create the first mailbox from the seed the script prints. Create my owner token and the agent token in the console, or tell me the exact clicks. The agent token is scoped to one mailbox. Show a new token once, then stop repeating it.
- Verify each step before the next one: dry-run JSON, `terraform plan` if you apply, Worker deploy output, `GET /health`, a mailbox row, and an agent `send` that returns `pending_review` with an empty outbound attempt log. Do not approve that message unless I say so, and only with the content hash the API returned.
- If a test would send real mail, skip it and tell me what I can click instead.
- Stop on the first error. Quote the command and the error, and do not continue with a workaround that sends mail or changes a live MX record.

Start by asking me for the account, the zone, and whether that zone already receives mail.
