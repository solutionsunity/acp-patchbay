// The rendering area's full-pane state pages (welcome, restoring,
// connecting, connect-failed) share one shape and one glyph size — set
// once here so a change propagates to every page.
import type { ReactNode } from "react";
import { Icon } from "../../shared/icon";

/** 3× the codicon base (16px) — the one leading-glyph size for all pages. */
const GLYPH_SIZE = 48;

export function StatePage(props: {
  icon: string;
  spin?: boolean;
  tag: ReactNode;
  /** Action row (buttons), rendered under the tagline when present. */
  children?: ReactNode;
}) {
  return (
    <div className="chat">
      <div className="empty">
        <div className="glyph">
          <Icon name={props.icon} spin={props.spin} size={GLYPH_SIZE} />
        </div>
        <div className="tag">{props.tag}</div>
        {props.children !== undefined && <div className="pick">{props.children}</div>}
      </div>
    </div>
  );
}
