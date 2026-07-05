// Agent View — render only. Ephemeral state; rehydrates from the orchestrator on mount.
import { render } from "preact";
import "./style.css";

function EmptyState() {
  return (
    <div class="empty">
      <div class="glyph">⧉</div>
      <div class="tag">No agent connected yet.</div>
    </div>
  );
}

render(<EmptyState />, document.getElementById("root")!);
