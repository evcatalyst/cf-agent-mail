# Your own mailbox for your agents

cf-agent-mail is a small mail system you run on your own Cloudflare account. Each agent gets an address on a domain you control, such as `surveys@mail.example.com`.

## Why have your own

A hosted agent inbox is convenient until you want the mail on your domain, a copy you can export, and a person in the loop before anything goes to a stranger. This project is that loop. You pay Cloudflare. You can turn sending off in one click.

## What an agent can do

An agent can read the inboxes you assigned, search them, and write drafts. It can ask to send, reply, or forward. That ask does not send the message. It comes back as waiting for review.

An agent cannot approve its own mail, cannot see mail sitting in quarantine, cannot create inboxes, and cannot add people to its allow list. It never receives your Cloudflare password or API token. It holds a mailbox token you can revoke.

## How the review queue protects you

You open a private page. It lists every inbox, a search box, and the review queue. Each outbound message shows the exact text that would be sent. Approving sends that text. If the draft changes, the approval is discarded and you approve again. Rejecting drops it.

Some incoming mail is held before the agent sees it. That includes messages that look like phishing, hidden instructions, or an attempt to talk the agent into sending mail or ignoring its rules. Read a held message before you release it. If you do nothing, retention deletes it later.

The kill switch freezes every send, including one-time codes.

## One-time codes

Sign-in codes and similar notices to your own address are the exception. They use a fixed template, they can only go to addresses you listed, and they do not wait in the queue. Anything else waits.

## A good default

Leave strict review on. Read the message before you approve it. If a message tells the agent to ignore its rules, forward all the mail, or open a surprising link, reject it.
