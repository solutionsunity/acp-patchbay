// Minimal markdown-to-Preact renderer for agent text (ui.md: "markdown,
// streams live"). Builds vnodes directly instead of parsing to an HTML string
// — agent-authored text can never carry a live tag or attribute this way,
// no sanitizer required. Covers the shapes agents actually stream: fenced
// code blocks, inline code, bold/italic, paragraphs.
import type { JSX } from "preact";

function renderInline(text: string, keyPrefix: string): (JSX.Element | string)[] {
  const nodes: (JSX.Element | string)[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${i++}`;
    if (match[1] !== undefined) nodes.push(<code key={key}>{match[1]}</code>);
    else if (match[2] !== undefined) nodes.push(<strong key={key}>{match[2]}</strong>);
    else if (match[3] !== undefined) nodes.push(<em key={key}>{match[3]}</em>);
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderParagraph(text: string, key: string): JSX.Element {
  const lines = text.split("\n");
  const out: (JSX.Element | string)[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${key}-br-${i}`} />);
    out.push(...renderInline(line, `${key}-${i}`));
  });
  return <p key={key}>{out}</p>;
}

export function Markdown({ text }: { text: string }) {
  const segments = text.split(/```(?:[^\n`]*)\n?/);
  // odd indices are fenced code-block bodies (a leading ``` opens, the next closes)
  const nodes: JSX.Element[] = segments.map((segment, i) => {
    const key = `seg-${i}`;
    if (i % 2 === 1) {
      return (
        <pre key={key}>
          <code>{segment.replace(/\n$/, "")}</code>
        </pre>
      );
    }
    const paragraphs = segment.split(/\n{2,}/).filter((p) => p.trim() !== "");
    return (
      <span key={key}>
        {paragraphs.map((p, j) => renderParagraph(p, `${key}-p-${j}`))}
      </span>
    );
  });
  return <>{nodes}</>;
}
