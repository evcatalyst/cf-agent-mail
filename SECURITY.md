# Security

cf-agent-mail stores other people's mail and can send mail as your domain. The design assumes inbound mail is hostile, agents make mistakes, and a stolen agent token should not be a Cloudflare account compromise.

## Trust boundaries

- **Inbound mail** is untrusted data. Bodies are sanitized to text before an agent sees them. HTML is not passed through. Classification quarantines instruction-like text, hidden text, bidirectional overrides, mismatched links, header injection, risky attachments, impersonation of a known name, one-time-code phishing, and fake approval language. Quarantined mail is invisible to agent tokens until an owner releases it. Nothing in the classifier is allowed to auto-release.
- **Agents** hold a per-mailbox token. The token is a peppered SHA-256 hash at rest. Scopes are bound to mailbox addresses. Create-inbox, delete-inbox, allow-list changes, review, quarantine release, and the kill switch are owner-only. Agents do not receive Cloudflare API tokens, and the Workers do not embed one.
- **Owners** use Cloudflare Access or an owner token. Console forms use a CSRF token. Cookies are HttpOnly. The console sets a strict Content-Security-Policy and does not load third-party scripts. Untrusted bodies are rendered as text.
- **Outbound mail** to anyone who is not an allow-listed owner of a fixed template waits for review. Approval checks a hash of the sender, recipients, subject, body, html, attachment hashes, and thread id. A mismatch returns 409 and does not send. Editing a draft cancels the approval. Secret-shaped content needs an explicit acknowledgement. BCC is rejected. The Workers do not set `Message-ID` or `Date`.
- **Template mail** is rendered on the server from `otp`, `alert`, `digest`, or `notify`. OTP codes are six digits. Other templates reject URLs. Recipients have to be on `OWNER_ALLOWLIST`.

## Operational controls

- Rate limits live in a Durable Object per mailbox, plus a global object for the account cap and template-mail cap.
- A kill switch freezes sends. Three hard bounces or complaints pause a mailbox. Suppressions block further sends to that address.
- Loop guards treat `Auto-Submitted`, bulk precedence, `List-Id`, and very long `References` chains as automatic mail. That mail is stored and is not woken to the agent.
- The audit log records actions and decisions without message bodies.
- Raw messages sit in a private R2 bucket. Attachment download URLs are HMAC-signed and short-lived. High-risk types are not given a download URL.
- Wake webhooks are HMAC-signed and carry ids, not bodies.
- Provider events are accepted only with that HMAC or an owner token.

## What you must do

- Dedicate a DNS zone to this mail. Enabling Email Routing replaces apex MX.
- Set `TOKEN_PEPPER`, `REPLY_HMAC_KEY`, and `WEBHOOK_SIGNING_KEY` with `wrangler secret put`. Do not deploy the root `wrangler.jsonc`.
- Put Access in front of `/admin`, or treat the owner token as a password.
- Leave `ENFORCE_KNOWN_AUTO` off until you have reviewed real traffic.
- Rotate a token by revoking it in the console. Rotating the pepper invalidates every token hash. Plan that as a maintenance window.

## Reporting

Report vulnerabilities through GitHub private vulnerability reporting on this repository. Do not file a public issue that includes message contents, tokens, or customer mail.

This repository does not ship account identifiers or personal mail. Do not add them in examples, issues, or pull requests.
