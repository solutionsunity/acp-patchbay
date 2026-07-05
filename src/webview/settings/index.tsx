// Settings — render only. Ephemeral state; rehydrates from the orchestrator on mount.
import { render } from "preact";
import "./style.css";

function Placeholder() {
  return (
    <div class="empty">
      <div class="tag">Patchbay settings — nothing to configure yet.</div>
    </div>
  );
}

render(<Placeholder />, document.getElementById("root")!);
