// § Rules · skills · commands: a navigational index onto files living in
// each agent's own native locations — real editing happens in VS Code's
// editor, never a webview dialect (render-only-webview.md).
import type { AgentAssetsView, AssetCategoryView, SettingsState } from "../../shared/protocol";
import { Button } from "@/components/ui/button";

function AssetCategory(props: {
  label: string;
  category: AssetCategoryView;
  onOpen(path: string): void;
}) {
  return (
    <div className="mt-2">
      <div className="cap">{props.label}</div>
      {props.category.files === null ? (
        <div className="note mx-0 mb-0 mt-0.5">
          not mapped
        </div>
      ) : props.category.files.length === 0 ? (
        <div className="note mx-0 mb-0 mt-0.5">
          mapped, nothing found in this workspace
        </div>
      ) : (
        props.category.files.map((f) => (
          <div key={f.path} className="it px-0 py-0.5" onClick={() => props.onOpen(f.path)}>
            <code>{f.path}</code>
          </div>
        ))
      )}
    </div>
  );
}

export function AssetsSection(props: {
  state: SettingsState;
  onRefresh(agentId: string): void;
  onOpen(agentId: string, path: string): void;
}) {
  const { state } = props;
  return (
    <section className="section">
      <h1>Rules · skills · commands</h1>
      <div className="sub">
        Managed in each agent's own native locations — the agent reads its own cwd. Patchbay never
        passes them down; opening a file uses VS Code's own editor, never a copy.
      </div>
      {state.agents.length === 0 && (
        <div className="card">
          <div className="note m-0">
            No agents connected yet.
          </div>
        </div>
      )}
      {state.agents.map((a) => {
        const assets: AgentAssetsView | undefined = state.assets[a.id];
        return (
          <div className="card" key={a.id}>
            <div className="row">
              <span className="nm">{a.name}</span>
              <span className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => props.onRefresh(a.id)}>
                Refresh
              </Button>
            </div>
            {assets === undefined ? (
              <div className="note mt-1.5">
                Not read yet — click Refresh.
              </div>
            ) : (
              <>
                <AssetCategory label="Rules" category={assets.rules} onOpen={(p) => props.onOpen(a.id, p)} />
                <AssetCategory label="Commands" category={assets.commands} onOpen={(p) => props.onOpen(a.id, p)} />
                <AssetCategory label="Skills" category={assets.skills} onOpen={(p) => props.onOpen(a.id, p)} />
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
