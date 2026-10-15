/**
 * @astra/stdio-runtime — unified AgentLoop local Host entry point.
 *
 * Loads the single Agent Host manifest, binds the existing single-reader
 * `P2HostChannel` to an Agent Host codec and forwards every frame to
 * `AgentHostFlow`. No second reader, framing or JSON parser is introduced
 * here, and this module never auto-executes: `main.ts` selects it explicitly
 * for the `--agent-loop` profile.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  agentHostPayload,
  parseAgentHostFrame,
  validateAgentHostManifest,
  type AgentHostManifest,
  type AgentHostMethod,
  type JsonRpcMessage,
} from "@astra/protocol";
import { P2HostChannel, type HostChannelCodec } from "./p2-host-channel.js";
import { AgentHostFlow } from "./agent-host-flow.js";

/**
 * The manifest URL. A self-contained precompiled bundle ships the schema next
 * to it (`./schema/...`); a normal in-repo build falls back to the workspace
 * package export. This keeps the bundle runnable without node_modules.
 */
function manifestUrl(): URL {
  const sibling = new URL("./schema/agent-host-v13.schema.json", import.meta.url);
  if (existsSync(sibling)) {
    return sibling;
  }
  return new URL(import.meta.resolve("@astra/protocol/schema/agent-host-v13.schema.json"));
}

function loadManifest(): AgentHostManifest {
  const raw = JSON.parse(readFileSync(manifestUrl(), "utf8")) as unknown;
  return validateAgentHostManifest(raw);
}

export function startAgentHost(startedAt: number = performance.now()): void {
  const manifest = loadManifest();
  const codec: HostChannelCodec<AgentHostMethod> = {
    parse: (bytes: Uint8Array) => parseAgentHostFrame(bytes, manifest),
    payload: (method: AgentHostMethod, side: "params" | "result", value: unknown) =>
      agentHostPayload(manifest, method, side, value),
  };
  const channel = new P2HostChannel<AgentHostMethod, AgentHostManifest>(
    manifest,
    startedAt,
    codec,
  );
  const flow = new AgentHostFlow(manifest, {
    remainingMs: () => channel.remainingMs(),
    tighten: (ms: number) => channel.tighten(ms),
    send: (message: JsonRpcMessage, method: AgentHostMethod) => channel.send(message, method),
    stop: (message: JsonRpcMessage) => channel.stop(message),
    fail: (error: unknown) => channel.fail(error),
  });
  channel.start((message: JsonRpcMessage) => flow.handle(message));
}
