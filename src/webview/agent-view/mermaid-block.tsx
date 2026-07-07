// ```mermaid blocks, owned end to end (Streamdown custom renderer):
// - an incomplete fence mid-stream shows the source dimmed — mermaid never
//   sees partial input, so no error bomb can flash while streaming;
// - a parse failure renders the honest fallback: the reason and the source,
//   never mermaid's bomb (suppressErrorRendering in the loader);
// - "Open in editor" hands the rendered SVG to the orchestrator, which
//   opens it as an editor-area panel — the files area is much bigger than
//   the agent view's inline zoom.
import { useEffect, useId, useState } from "react";
import { useActions } from "../shared/actions";
import { useCopy } from "../shared/use-copy";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";

type RenderState =
  | { kind: "pending" }
  | { kind: "ok"; svg: string }
  | { kind: "failed"; reason: string };

export function MermaidBlock({ code, isIncomplete }: { code: string; isIncomplete: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [state, setState] = useState<RenderState>({ kind: "pending" });
  const send = useActions();
  const { copied, copy } = useCopy();

  useEffect(() => {
    if (isIncomplete) return undefined;
    let alive = true;
    setState({ kind: "pending" });
    void import("./mermaid-loader").then(({ renderMermaid }) =>
      renderMermaid(`mmd-${id}`, code).then(
        ({ svg }) => {
          if (alive) setState({ kind: "ok", svg });
        },
        (err: unknown) => {
          if (alive) setState({ kind: "failed", reason: err instanceof Error ? err.message : String(err) });
        },
      ),
    );
    return () => {
      alive = false;
    };
  }, [code, isIncomplete, id]);

  if (isIncomplete || state.kind === "pending") {
    return (
      <div className="my-4 rounded-lg border border-border bg-sidebar p-2">
        <div className="flex h-6 items-center gap-1 px-1 font-mono text-xs lowercase text-muted-foreground">
          mermaid
          {(isIncomplete || state.kind === "pending") && <Icon name="loading" spin />}
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
          {code}
        </pre>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="my-4 rounded-lg border border-border bg-sidebar p-2">
        <div className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-warn">
          <Icon name="warning" /> diagram didn't parse — source shown ({state.reason.split("\n")[0]})
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div className="my-4 rounded-lg border border-border bg-sidebar p-2" data-patchbay="mermaid">
      <div className="flex h-6 items-center gap-1 px-1">
        <span className="font-mono text-xs lowercase text-muted-foreground">mermaid</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          title="Copy source"
          aria-label="Copy mermaid source"
          onClick={() => copy(code)}
        >
          <Icon name={copied ? "check" : "copy"} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          title="Open in editor — full size"
          aria-label="Open diagram in editor"
          onClick={() => send({ kind: "openDiagram", svg: state.svg })}
        >
          <Icon name="link-external" />
        </Button>
      </div>
      {/* mermaid sanitizes its output (securityLevel strict, the default) */}
      <div
        className="overflow-x-auto rounded-md border border-border bg-background p-3 [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </div>
  );
}
