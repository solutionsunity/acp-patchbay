// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

/** An agent-offered option as a list shows it: its name, with its
 * description folded in when another of the same choice shares the name (an
 * agent's model variants can) — so the chosen one can be told apart where
 * only its label shows — and otherwise the description on its own line. */
export function optionText(
  option: { name: string; description?: string },
  options: readonly { name: string }[],
): { label: string; description?: string } {
  if (option.description === undefined) return { label: option.name };
  return options.filter((o) => o.name === option.name).length > 1
    ? { label: `${option.name} · ${option.description}` }
    : { label: option.name, description: option.description };
}
