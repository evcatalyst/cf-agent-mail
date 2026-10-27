declare module "../../bootstrap/plan.mjs" {
  export function buildPlan(input: Record<string, unknown>): {
    dryRunDefault: boolean;
    warnings: string[];
    dns: { name: string }[];
    workers: { inbound: { addresses: string[] } };
  };
}

declare module "../../bootstrap/import-agentmail.mjs" {
  export function mapAgentMailExport(
    doc: Record<string, unknown>,
    options: { mailDomain: string },
  ): {
    skipped: string[];
    threads: { legacyThreadId: string }[];
    sql: string[];
  };
}
