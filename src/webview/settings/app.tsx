// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Settings shell — left nav + one section at a time.
// Render-only: the open section is host-owned state (state.section), so it
// survives webview disposal and openSettings can deep-link to it; each
// section module owns its markup and wiring. Empty states are honest, never
// placeholders pretending to be data.
import type { SettingsSectionId, SettingsState } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { ErrorsChip } from "../shared/errors-chip";
import { Icon } from "../shared/icon";
import { AgentsSection } from "./agents";
import { AuditSection } from "./audit";
import { DataSection } from "./data";
import { McpServersSection } from "./mcp-servers";
import { MatrixSection } from "./matrix";
import { PermissionsSection } from "./permissions";
import { PreferencesSection } from "./preferences";
import { RootsSection } from "./roots";

/** Grouped by what the group *is*, not by theme: "This machine" is what's
 * global to this machine (the wiring — agents, MCP servers, the matrix
 * observing them — and behavior preferences; machine store/SecretStorage;
 * Saved roots also carries this workspace's list, beside the machine one),
 * "Trust" is the one trust surface. The nav teaches the placement contract
 * instead of captioning it. */
const NAV_GROUPS = [
  {
    label: "This machine",
    items: [
      { id: "agents", icon: "plug", label: "Agents" },
      { id: "matrix", icon: "table", label: "Capability matrix" },
      { id: "mcpServers", icon: "server", label: "MCP Servers" },
      { id: "preferences", icon: "settings-gear", label: "Preferences" },
      { id: "roots", icon: "root-folder", label: "Saved roots" },
    ],
  },
  // Formerly two groups (Trust / Transparency) — merged, not deleted: all
  // three are facets of the one trust surface (Permissions is the contract,
  // Audit the evidence, Data what's held and the way out). The one-verb-per-
  // page discipline lives at page boundaries, where it always actually did.
  {
    label: "Trust",
    items: [
      { id: "permissions", icon: "shield", label: "Permissions" },
      { id: "audit", icon: "eye", label: "Audit" },
      { id: "data", icon: "database", label: "Data" },
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ id: SettingsSectionId; icon: string; label: string }>;
}>;

export function App({ state }: { state: SettingsState }) {
  const send = useActions();
  const section = state.section;

  return (
    <div className="layout">
      <nav className="nav">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="grp">{group.label}</div>
            {group.items.map((s) => (
              <div
                key={s.id}
                className={`it ${section === s.id ? "on" : ""}`}
                onClick={() => send({ kind: "setSettingsSection", section: s.id })}
              >
                <Icon name={s.icon} /> {s.label}
              </div>
            ))}
          </div>
        ))}
        <ErrorsChip />
        <div className="foot">
          agents &amp; MCP servers: global (this machine)
          <br />
          never repo-committed
          <br />
          credentials: SecretStorage only
        </div>
      </nav>
      <main className="main">
        {section === "agents" && (
          <AgentsSection
            state={state}
            onConnectConfigured={(patchbayAgentId) =>
              send({ kind: "connectAgent", source: { patchbayAgentId } })
            }
            onAddAgent={(source) => send({ kind: "connectAgent", source })}
            onSave={(config) => send({ kind: "addOrUpdateAgentConfig", config })}
            onRemove={(patchbayAgentId) => send({ kind: "removeAgentConfig", patchbayAgentId })}
            onStop={(patchbayAgentId) => send({ kind: "stopAgent", patchbayAgentId })}
            onRestart={(patchbayAgentId) => send({ kind: "restartAgent", patchbayAgentId })}
            onAuthenticate={(patchbayAgentId, methodId) =>
              send({ kind: "authenticateAgent", patchbayAgentId, methodId })
            }
            onLogout={(patchbayAgentId) => send({ kind: "logoutAgent", patchbayAgentId })}
            onUpgrade={(patchbayAgentId) => send({ kind: "upgradeAgent", patchbayAgentId })}
            onRefreshRegistry={() => send({ kind: "refreshRegistry" })}
            onReorder={(patchbayAgentIds) => send({ kind: "reorderAgentConfigs", patchbayAgentIds })}
            onEditDefaults={(patchbayAgentId, open) => send({ kind: "editAgentDefaults", patchbayAgentId, open })}
          />
        )}
        {section === "matrix" && <MatrixSection state={state} />}
        {section === "preferences" && (
          <PreferencesSection
            state={state}
            onSet={(patch) => send({ kind: "setPreferences", patch })}
            onPreview={(sound) => send({ kind: "previewDoneSound", sound })}
          />
        )}
        {section === "roots" && (
          <RootsSection
            state={state}
            onAdd={(scope) => send({ kind: "pickSavedRoot", scope })}
            onEdit={(replacing, scope) => send({ kind: "pickSavedRoot", scope, replacing })}
            onRemove={(path, scope) => send({ kind: "unsaveRoot", path, scope })}
          />
        )}
        {section === "mcpServers" && (
          <McpServersSection
            state={state}
            onConnectKey={(catalogId, token, url) =>
              send({ kind: "connectCatalogKey", catalogId, token, url })
            }
            onConnectOAuth={(catalogId, url) =>
              send({ kind: "connectCatalogOAuth", catalogId, url })
            }
            onAddCustom={(name, source, routing) =>
              send({ kind: "addCustomMcpServer", name, source, routing })
            }
            onImportJson={(json) => send({ kind: "importMcpServersJson", json })}
            onUpdateJson={(patchbayMcpServerId, json) =>
              send({ kind: "updateMcpServerJson", patchbayMcpServerId, json })
            }
            onCancelConnect={(key) =>
              send({ kind: "cancelMcpServerConnect", key })
            }
            onSetActive={(patchbayMcpServerId, active) =>
              send({ kind: "setMcpServerActive", patchbayMcpServerId, active })
            }
            onRemove={(patchbayMcpServerId) => send({ kind: "removeMcpServer", patchbayMcpServerId })}
            onSetRouting={(patchbayMcpServerId, routing) =>
              send({ kind: "setMcpServerRouting", patchbayMcpServerId, routing })
            }
            onSetTransport={(patchbayMcpServerId, transport) =>
              send({ kind: "setMcpServerTransport", patchbayMcpServerId, transport })
            }
            onProbe={(patchbayMcpServerId) => send({ kind: "probeMcpServer", patchbayMcpServerId })}
            onCopy={(patchbayMcpServerId) => send({ kind: "copyMcpServerJson", patchbayMcpServerId })}
            onReorder={(patchbayMcpServerIds) => send({ kind: "reorderMcpServers", patchbayMcpServerIds })}
          />
        )}
        {section === "permissions" && (
          <PermissionsSection
            state={state}
            onAddRule={(rule, layer) => send({ kind: "addCommandRule", rule, layer })}
            onRemoveRule={(pattern, layer) => send({ kind: "removeCommandRule", pattern, layer })}
            onSetScope={(scope) => send({ kind: "setFileWriteScope", scope })}
          />
        )}
        {section === "audit" && (
          <AuditSection
            state={state}
            onSetWireLog={(active) => send({ kind: "setWireLog", active })}
          />
        )}
        {section === "data" && (
          <DataSection
            state={state}
            onRefresh={() => send({ kind: "refreshDataInventory" })}
            onEraseAll={() => send({ kind: "eraseAllData" })}
          />
        )}
      </main>
    </div>
  );
}
