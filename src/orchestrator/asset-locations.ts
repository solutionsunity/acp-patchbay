// Resolves a roster agent's rules/skills/commands locations (architecture.md
// § Rules, skills, commands) into the files actually on disk in this
// workspace — management only, v1 is view + navigate, never delivery. A
// structural `FsLike` (mirrors kv.ts's `KV`) keeps the resolution logic
// vscode-free and unit-testable; the real implementation just wraps
// vscode.workspace.fs.
import { join } from "node:path";
import type { AssetLocations } from "./stores/roster";

export interface FsEntry {
  name: string;
  isDirectory: boolean;
}

export interface FsLike {
  /** null when the path doesn't exist — never thrown, since "not present in
   * this workspace" is an expected, honest outcome, not an error. */
  stat(path: string): Promise<{ isDirectory: boolean } | null>;
  readdir(path: string): Promise<FsEntry[]>;
}

export interface AssetFileView {
  /** Relative to the workspace root — what Settings shows and what
   * `openAssetFile` resolves back to an absolute path. */
  path: string;
}

export interface AssetCategoryView {
  /** null = this category isn't mapped for this agent (roster data), shown
   * as unmapped — never guessed, never silently skipped. */
  files: readonly AssetFileView[] | null;
}

export interface AgentAssetsView {
  agentId: string;
  rules: AssetCategoryView;
  commands: AssetCategoryView;
  skills: AssetCategoryView;
}

async function resolveCategory(
  fs: FsLike,
  workspaceRoot: string,
  patterns: readonly string[] | null,
): Promise<AssetCategoryView> {
  if (patterns === null) return { files: null };
  const files: AssetFileView[] = [];
  for (const pattern of patterns) {
    const abs = join(workspaceRoot, pattern);
    const stat = await fs.stat(abs);
    if (stat === null) continue; // not present in this workspace — not every listed path always exists
    if (!stat.isDirectory) {
      files.push({ path: pattern });
      continue;
    }
    for (const entry of await fs.readdir(abs)) {
      if (!entry.isDirectory) files.push({ path: join(pattern, entry.name) });
    }
  }
  return { files };
}

export async function resolveAgentAssets(
  fs: FsLike,
  workspaceRoot: string,
  agentId: string,
  assets: AssetLocations | null,
): Promise<AgentAssetsView> {
  return {
    agentId,
    rules: await resolveCategory(fs, workspaceRoot, assets?.rules ?? null),
    commands: await resolveCategory(fs, workspaceRoot, assets?.commands ?? null),
    skills: await resolveCategory(fs, workspaceRoot, assets?.skills ?? null),
  };
}
