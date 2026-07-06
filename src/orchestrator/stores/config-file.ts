// Workspace config: .vscode/acp-patchbay.json — inspectable, repo-shareable,
// no credentials ever (architecture.md § State). Parsed as JSONC (humans edit
// it), validated with zod (a trust boundary: malformed input becomes typed
// errors, not undefined behavior). Writes are surgical jsonc-parser edits so
// user comments and unknown keys survive round-trips.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
} from "jsonc-parser";
import { z } from "zod";

export const CONFIG_RELATIVE_PATH = join(".vscode", "acp-patchbay.json");

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  processPolicy: z.enum(["auto", "shared", "isolated"]).default("auto"),
  defaults: z
    .object({
      model: z.string().optional(),
      mode: z.string().optional(),
      effort: z.string().optional(),
    })
    .default({}),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// Integrations (architecture.md § Integrations, § State — workspace-scoped,
// in the config file, never credentials). "Curated and custom are the same
// mechanism": a registry-backed source or a custom stdio/http one, each
// producing an mcpServers entry the same way. No credential field exists
// here by construction — those live only in SecretStorage
// (integration-tokens.ts), keyed by `id`. Auth shapes per
// docs/reference-mcp-oauth.md: a static key in a configurable header, or
// MCP-spec OAuth 2.1 (URL-only; client id and endpoints are discovered and
// live with the token in SecretStorage, not here).
export const integrationSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("registry"),
    registryId: z.string().min(1),
    /** User-supplied endpoint, for registry entries with per-account URLs
     * (Supabase, Augment). Absent when the entry ships a fixed URL. */
    url: z.string().optional(),
    /** Which of the entry's offered mechanisms this connection used —
     * decides how the bridge formats the auth header. */
    authMode: z.enum(["header", "oauth"]).default("header"),
  }),
  z.object({
    kind: z.literal("custom-stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    kind: z.literal("custom-http"),
    url: z.string().min(1),
    /** "none" needs no secret; "header" sends the stored key as
     * `{headerName}: {valuePrefix}{key}`; "oauth" runs the MCP-spec OAuth
     * flow against the URL and sends `Authorization: Bearer <token>`. */
    authType: z.enum(["none", "header", "oauth"]).default("none"),
    headerName: z.string().default("Authorization"),
    valuePrefix: z.string().default("Bearer "),
  }),
]);

export type IntegrationSource = z.infer<typeof integrationSourceSchema>;

export const integrationConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: integrationSourceSchema,
  /** "auto" (default) attaches only to agents whose fidelity is fully
   * brokered (features.md § Integrations); an explicit id list pins exactly
   * which agents receive it — the user's routing, never all-or-nothing. */
  routing: z.union([z.literal("auto"), z.array(z.string())]).default("auto"),
});

export type IntegrationConfig = z.infer<typeof integrationConfigSchema>;

export const workspaceConfigSchema = z.object({
  agents: z.array(agentConfigSchema).default([]),
  integrations: z.array(integrationConfigSchema).default([]),
});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export const emptyWorkspaceConfig: WorkspaceConfig = { agents: [], integrations: [] };

export type ConfigReadResult =
  | { ok: true; config: WorkspaceConfig }
  | { ok: false; error: string };

export function parseWorkspaceConfig(text: string): ConfigReadResult {
  const errors: ParseError[] = [];
  const data: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) {
    return { ok: false, error: `invalid JSONC (offset ${errors[0]!.offset})` };
  }
  const result = workspaceConfigSchema.safeParse(data ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `invalid config: ${issue ? `${issue.path.join(".")} — ${issue.message}` : "unknown"}`,
    };
  }
  return { ok: true, config: result.data };
}

function arrayField(existing: unknown, field: string): unknown[] {
  return typeof existing === "object" &&
    existing !== null &&
    Array.isArray((existing as Record<string, unknown>)[field])
    ? ((existing as Record<string, unknown>)[field] as unknown[])
    : [];
}

function indexOfId(items: unknown[], id: string): number {
  return items.findIndex(
    (item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id === id,
  );
}

export class ConfigFileStore {
  /** file: absolute path to .vscode/acp-patchbay.json, or null when no workspace. */
  constructor(private readonly file: string | null) {}

  async read(): Promise<ConfigReadResult> {
    if (this.file === null) return { ok: true, config: emptyWorkspaceConfig };
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return { ok: true, config: emptyWorkspaceConfig }; // absent file = empty config
    }
    return parseWorkspaceConfig(text);
  }

  /** Upserts `value` at `[field, id]` by matching id, appending if absent —
   * shared by agents and integrations, both id-keyed arrays in the same file. */
  private async upsertInArray(field: string, id: string, value: unknown): Promise<void> {
    if (this.file === null) throw new Error("no workspace open");
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      await mkdir(dirname(this.file), { recursive: true });
      text = "{\n}\n";
    }
    const items = arrayField(parseJsonc(text, [], { allowTrailingComma: true }), field);
    const index = indexOfId(items, id);
    const edits = modify(text, [field, index === -1 ? items.length : index], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    await writeFile(this.file, applyEdits(text, edits), "utf8");
  }

  private async removeFromArray(field: string, id: string): Promise<void> {
    if (this.file === null) throw new Error("no workspace open");
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return;
    }
    const items = arrayField(parseJsonc(text, [], { allowTrailingComma: true }), field);
    const index = indexOfId(items, id);
    if (index === -1) return;
    const edits = modify(text, [field, index], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    await writeFile(this.file, applyEdits(text, edits), "utf8");
  }

  upsertAgent(agent: AgentConfig): Promise<void> {
    return this.upsertInArray("agents", agent.id, agent);
  }

  removeAgent(agentId: string): Promise<void> {
    return this.removeFromArray("agents", agentId);
  }

  upsertIntegration(integration: IntegrationConfig): Promise<void> {
    return this.upsertInArray("integrations", integration.id, integration);
  }

  removeIntegration(integrationId: string): Promise<void> {
    return this.removeFromArray("integrations", integrationId);
  }

  async setIntegrationRouting(integrationId: string, routing: IntegrationConfig["routing"]): Promise<void> {
    const result = await this.read();
    if (!result.ok) return;
    const integration = result.config.integrations.find((i) => i.id === integrationId);
    if (integration === undefined) return;
    await this.upsertIntegration({ ...integration, routing });
  }
}
