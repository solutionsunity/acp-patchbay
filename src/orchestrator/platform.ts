// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The platform vocabulary — THE one place an OS or CPU name is spelled for
// a publisher. Node names the machine (`process.platform`, `process.arch`);
// everything patchbay downloads is published under someone else's names:
// the ACP registry's binary targets (`windows-x86_64`), nodejs.org's
// archives (`win-x64`), a Rust target triple (`x86_64-pc-windows-msvc`).
// One table holds the platforms any of them build for, with each spelling
// beside it; every publisher's name is a projection of that table, so a
// platform is added (or a spelling fixed) in one row.
//
// A machine outside the table (freebsd, ia32) has no platform here: nothing
// is downloaded for it, never a guessed name. Comparing `process.platform`
// to "win32" stays where a site needs it — that is Node's own name, read
// directly; only the publishers' spellings live here.

const OS = {
  darwin: { registry: "darwin", node: "darwin", rust: "apple-darwin" },
  linux: { registry: "linux", node: "linux", rust: "unknown-linux-gnu" },
  win32: { registry: "windows", node: "win", rust: "pc-windows-msvc" },
} as const;

const ARCH = {
  x64: { registry: "x86_64", node: "x64", rust: "x86_64" },
  arm64: { registry: "aarch64", node: "arm64", rust: "aarch64" },
} as const;

/** A machine some publisher builds for, in Node's own names. */
export interface Platform {
  os: keyof typeof OS;
  arch: keyof typeof ARCH;
}

/** The platform Node reports, or null for one no publisher builds for. */
export function platformOf(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Platform | null {
  return Object.hasOwn(OS, platform) && Object.hasOwn(ARCH, arch)
    ? { os: platform as Platform["os"], arch: arch as Platform["arch"] }
    : null;
}

/** The ACP registry's binary target key: `darwin-aarch64`. */
export function registryTarget(p: Platform): string {
  return `${OS[p.os].registry}-${ARCH[p.arch].registry}`;
}

/** nodejs.org's archive platform: `win-x64`. */
export function nodeDistName(p: Platform): string {
  return `${OS[p.os].node}-${ARCH[p.arch].node}`;
}

/** The Rust target triple uv's releases are named by: `x86_64-pc-windows-msvc`. */
export function rustTarget(p: Platform): string {
  return `${ARCH[p.arch].rust}-${OS[p.os].rust}`;
}
