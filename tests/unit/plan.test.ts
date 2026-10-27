import { describe, expect, it } from "vitest";
import { mapAgentMailExport } from "../../bootstrap/import-agentmail.mjs";
import { buildPlan } from "../../bootstrap/plan.mjs";

const config = {
  account_id: "YOUR_ACCOUNT_ID",
  zone_id: "YOUR_ZONE_ID",
  zone_name: "mail.example.com",
  mail_subdomain: "@",
  system_subdomain: "login",
  api_subdomain: "relay",
  owner_email: "owner@example.com",
  mailbox_slugs: ["surveys", "socials"],
  resource_prefix: "cf-agent-mail",
  enable_email_sending: false,
  enable_routing: false,
  enable_access: false,
};

describe("bootstrap plan", () => {
  it("uses only the domains in the config and warns about MX", () => {
    const plan = buildPlan(config);
    const text = JSON.stringify(plan);
    expect(text).toContain("surveys@mail.example.com");
    expect(text).toContain("login.mail.example.com");
    expect(text).not.toContain("canalandcountry");
    expect(text).not.toContain("chartspec");
    expect(plan.dryRunDefault).toBe(true);
    expect(plan.warnings.join(" ")).toMatch(/MX/i);
    expect(
      plan.dns.some((record: { name: string }) =>
        record.name.includes("mail.example.com"),
      ),
    ).toBe(true);
    const inbound = plan.workers.inbound as { addresses?: string[] };
    expect(inbound.addresses).toEqual([
      "surveys@mail.example.com",
      "socials@mail.example.com",
    ]);
    expect(JSON.stringify(plan.workers)).not.toContain("remote");
  });
});

describe("agentmail import", () => {
  it("keeps the legacy thread id and skips other domains", () => {
    const mapped = mapAgentMailExport(
      {
        inboxes: [
          { inboxId: "surveys@mail.example.com", displayName: "Surveys" },
          { inboxId: "other@example.net" },
        ],
        threads: [
          {
            threadId: "legacy-1",
            inboxId: "surveys@mail.example.com",
            subject: "Hello",
            messages: [
              {
                messageId: "<m@example.com>",
                from: "vendor@example.com",
                text: "Hi",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      },
      { mailDomain: "mail.example.com" },
    );
    expect(mapped.skipped).toEqual(["other@example.net"]);
    expect(mapped.threads[0].legacyThreadId).toBe("legacy-1");
    expect(mapped.sql.join("\n")).toContain("legacy-1");
  });
});
