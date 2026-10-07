// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What an agent asks of patchbay's file system and terminals, read: the
// session it asks in, and what it asks for — an absent field absent, the
// wire's null read as not sent.
import type {
  CreateTerminalRequest,
  ReadTextFileRequest,
  ReleaseTerminalRequest,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import { present } from "./content";

/** fs/read_text_file: `line` is 1-based, `limit` a line count. */
export interface FileReadFact {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface FileWriteFact {
  sessionId: string;
  path: string;
  content: string;
}

/** terminal/create: what to run, as the agent asked — `cwd` absent means
 * the session's own directory; `outputByteLimit` absent means the agent
 * set none. */
export interface TerminalCreateFact {
  sessionId: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
  outputByteLimit?: number;
}

/** terminal/output, wait_for_exit, kill, release: the terminal a request
 * names, in the session it names. */
export interface TerminalRefFact {
  sessionId: string;
  terminalId: string;
}

export function readFileRead(request: ReadTextFileRequest): FileReadFact {
  return { sessionId: request.sessionId, path: request.path, ...present("line", request.line), ...present("limit", request.limit) };
}

export function readFileWrite(request: WriteTextFileRequest): FileWriteFact {
  return { sessionId: request.sessionId, path: request.path, content: request.content };
}

export function readTerminalCreate(request: CreateTerminalRequest): TerminalCreateFact {
  return {
    sessionId: request.sessionId,
    command: request.command,
    args: request.args ?? [],
    env: Object.fromEntries((request.env ?? []).map((e) => [e.name, e.value])),
    ...present("cwd", request.cwd),
    ...present("outputByteLimit", request.outputByteLimit),
  };
}

/** Every terminal request names its terminal the same way. */
export function readTerminalRef(request: ReleaseTerminalRequest): TerminalRefFact {
  return { sessionId: request.sessionId, terminalId: request.terminalId };
}
