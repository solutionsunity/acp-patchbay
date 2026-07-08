// Settings shell — left nav + one section at a time (ui.md § Settings).
// Render-only: the shell owns only which section is open; each section
// module owns its markup and wiring. Empty states are honest, never
// placeholders pretending to be data.
import { useState } from "react";
import type { SettingsState } from "../../shared/protocol";
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

/** Grouped by what the group *is*, not by theme: "This machine" is the
 * global wiring (agents, integrations, and the matrix observing them —
 * globalState/SecretStorage), "Trust" is the permission surface (spans the
 * machine floor and this workspace's rules), "This workspace" is what lives
 * in the workspace itself (asset files the agent reads from its own cwd).
 * The nav teaches the placement contract instead of captioning it. */
const NAV_GROUPS = [
  {
    label: "This machine",
    items: [
      { id: "agents", icon: "plug", label: "Agents" },
      { id: "matrix", icon: "table", label: "Capability matrix" },
      { id: "integrations", icon: "server", label: "MCP Servers" },
    ],
  },
  {
    label: "Trust",
    items: [{ id: "permissions", icon: "shield", label: "Permissions" }],
  },
  // One verb per page: Permissions sets the rules, Audit reviews what
  // happened (decisions + wire), Data shows what's stored and the way out.
  {
    label: "Transparency",
    items: [
      { id: "audit", icon: "eye", label: "Audit" },
      { id: "data", icon: "database", label: "Data" },
    ],
  },
  {
    label: "This workspace",
    items: [{ id: "assets", icon: "note", label: "Rules · skills · commands" }],
  },
] as const;

type SectionId = (typeof NAV_GROUPS)[number]["items"][number]["id"];

export function App({ state }: { state: SettingsState }) {
  const send = useActions();
  const [section, setSection] = useState<SectionId>("agents");

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
                onClick={() => setSection(s.id)}
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
            onUpgrade={(agentId) => send({ kind: "upgradeAgent", agentId })}
            onRefreshRoster={() => send({ kind: "refreshRoster" })}
            onConfirmBinaryInstall={(agentId) => send({ kind: "confirmBinaryInstall", agentId })}
            onCancelBinaryInstall={(agentId) => send({ kind: "cancelBinaryInstall", agentId })}
          />
        )}
        {section === "matrix" && <MatrixSection state={state} />}
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
