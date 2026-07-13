// Settings shell — left nav + one section at a time (ui.md § Settings).
// Render-only: the open section is host-owned state (state.section), so it
// survives webview disposal and openSettings can deep-link to it; each
// section module owns its markup and wiring. Empty states are honest, never
// placeholders pretending to be data.
import type { SettingsSectionId, SettingsState } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { ErrorsChip } from "../shared/errors-chip";
import { Icon } from "../shared/icon";
import { AgentsSection } from "./agents";
import { AssetsSection } from "./assets";
import { AuditSection } from "./audit";
import { DataSection } from "./data";
import { IntegrationsSection } from "./integrations";
import { MatrixSection } from "./matrix";
import { PermissionsSection } from "./permissions";
import { PreferencesSection } from "./preferences";

/** Grouped by what the group *is*, not by theme: "This machine" is what's
 * global to this machine (the wiring — agents, integrations, the matrix
 * observing them — and behavior preferences; globalState/SecretStorage),
 * "Trust" is the one trust surface (prd.md), "This workspace" is what lives
 * in the workspace itself (asset files the agent reads from its own cwd).
 * The nav teaches the placement contract instead of captioning it. */
const NAV_GROUPS = [
  {
    label: "This machine",
    items: [
      { id: "agents", icon: "plug", label: "Agents" },
      { id: "matrix", icon: "table", label: "Capability matrix" },
      { id: "integrations", icon: "server", label: "MCP Servers" },
      { id: "preferences", icon: "settings-gear", label: "Preferences" },
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
  {
    label: "This workspace",
    items: [{ id: "assets", icon: "note", label: "Rules · skills · commands" }],
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
          agents &amp; integrations: global (this machine)
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
            onVerify={(agentId) => send({ kind: "verifyAgent", agentId })}
            onConnectConfigured={(agentId) =>
              send({ kind: "connectAgent", source: { configuredId: agentId } })
            }
            onAddAgent={(source, verifyAfterConnect) =>
              send({ kind: "connectAgent", source, verifyAfterConnect })
            }
            onSave={(config, env) => send({ kind: "addOrUpdateAgentConfig", config, env })}
            onRemove={(agentId) => send({ kind: "removeAgentConfig", agentId })}
            onStop={(agentId) => send({ kind: "stopAgent", agentId })}
            onRestart={(agentId) => send({ kind: "restartAgent", agentId })}
            onAuthenticate={(agentId, methodId) =>
              send({ kind: "authenticateAgent", agentId, methodId })
            }
            onLogout={(agentId) => send({ kind: "logoutAgent", agentId })}
            onUpgrade={(agentId) => send({ kind: "upgradeAgent", agentId })}
            onRefreshRegistry={() => send({ kind: "refreshRegistry" })}
            onConfirmBinaryInstall={(agentId) => send({ kind: "confirmBinaryInstall", agentId })}
            onCancelBinaryInstall={(agentId) => send({ kind: "cancelBinaryInstall", agentId })}
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
        {section === "integrations" && (
          <IntegrationsSection
            state={state}
            onConnectKey={(registryId, token, url) =>
              send({ kind: "connectRegistryKey", registryId, token, url })
            }
            onConnectOAuth={(registryId, url) =>
              send({ kind: "connectRegistryOAuth", registryId, url })
            }
            onAddCustom={(name, source, routing) =>
              send({ kind: "addCustomIntegration", name, source, routing })
            }
            onImportJson={(json) => send({ kind: "importIntegrationsJson", json })}
            onUpdateJson={(integrationId, json) =>
              send({ kind: "updateIntegrationJson", integrationId, json })
            }
            onCancelConnect={(integrationId) =>
              send({ kind: "cancelIntegrationConnect", integrationId })
            }
            onSetActive={(integrationId, active) =>
              send({ kind: "setIntegrationActive", integrationId, active })
            }
            onRemove={(integrationId) => send({ kind: "removeIntegration", integrationId })}
            onSetRouting={(integrationId, routing) =>
              send({ kind: "setIntegrationRouting", integrationId, routing })
            }
            onSetTransport={(integrationId, transport) =>
              send({ kind: "setIntegrationTransport", integrationId, transport })
            }
            onProbe={(integrationId) => send({ kind: "probeIntegration", integrationId })}
            onShare={(integrationId) => send({ kind: "shareIntegrationConfig", integrationId })}
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
        {section === "assets" && (
          <AssetsSection
            state={state}
            onRefresh={(agentId) => send({ kind: "refreshAgentAssets", agentId })}
            onOpen={(agentId, path) => send({ kind: "openAssetFile", agentId, path })}
          />
        )}
      </main>
    </div>
  );
}
