// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The ACP SDK, at the one entrypoint patchbay speaks it through. The SDK's
// default entrypoint is the stable protocol alone; patchbay reads surfaces
// still marked unstable (fork, a prompt's usage, the plan-update and
// sub-agent kinds an agent may send), so every protocol type and the client
// connection come from the unstable entrypoint — one choice, made here, so
// no two files see two different protocols.
export * from "@agentclientprotocol/sdk/unstable";
