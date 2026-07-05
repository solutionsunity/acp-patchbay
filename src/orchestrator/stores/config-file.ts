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

export const workspaceConfigSchema = z.object({
  agents: z.array(agentConfigSchema).default([]),
});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export const emptyWorkspaceConfig: WorkspaceConfig = { agents: [] };

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

  async upsertAgent(agent: AgentConfig): Promise<void> {
    if (this.file === null) throw new Error("no workspace open");
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      await mkdir(dirname(this.file), { recursive: true });
      text = "{\n}\n";
    }
    const existing: unknown = parseJsonc(text, [], { allowTrailingComma: true });
    const agents: unknown[] =
      typeof existing === "object" &&
      existing !== null &&
      Array.isArray((existing as Record<string, unknown>).agents)
        ? ((existing as Record<string, unknown>).agents as unknown[])
        : [];
    const index = agents.findIndex(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        (a as Record<string, unknown>).id === agent.id,
    );
    const edits = modify(
      text,
      ["agents", index === -1 ? agents.length : index],
      agent,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } },
    );
    await writeFile(this.file, applyEdits(text, edits), "utf8");
  }

  async removeAgent(agentId: string): Promise<void> {
    if (this.file === null) throw new Error("no workspace open");
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return;
    }
    const existing: unknown = parseJsonc(text, [], { allowTrailingComma: true });
    const agents: unknown[] =
      typeof existing === "object" &&
      existing !== null &&
      Array.isArray((existing as Record<string, unknown>).agents)
        ? ((existing as Record<string, unknown>).agents as unknown[])
        : [];
    const index = agents.findIndex(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        (a as Record<string, unknown>).id === agentId,
    );
    if (index === -1) return;
    const edits = modify(text, ["agents", index], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    await writeFile(this.file, applyEdits(text, edits), "utf8");
  }
}
