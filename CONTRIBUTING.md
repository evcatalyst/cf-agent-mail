# Contributing

Issues and pull requests are welcome. Keep the repository usable by someone deploying it to their own Cloudflare account.

- Do not add real account ids, zone names, domains, emails, hostnames, or personal names. Use `example.com`, `owner@example.com`, and placeholders such as `YOUR_ACCOUNT_ID`.
- Do not add AGPL code, and do not copy another mail product's implementation into this repo. Parsing uses `postal-mime`.
- Do not deploy to Cloudflare or send mail from CI or from a pull request. Tests run in Miniflare with `EMAIL_MODE=record`.
- Do not put secrets in Wrangler vars. Production secrets are `wrangler secret put` only. The root `wrangler.jsonc` is a local test file.
- Keep strict review as the default. Do not make `known-auto` send unless `ENFORCE_KNOWN_AUTO` is explicitly true.
- Agents must not gain Cloudflare credentials, owner scope, or a path that sends third-party mail without `pending_review`.

## Checks

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

`npm run types` regenerates `worker-configuration.d.ts` after a Wrangler config change. Do not hand-edit that file.

A change to the admin console needs a test that exercises the route. Browser verification is optional when Miniflare covers the response.

## Pull requests

Describe what changed and how you tested it. If you change onboarding, walk through `docs/SELF-HOSTING.md` against the dry run and update the docs in the same pull request.
