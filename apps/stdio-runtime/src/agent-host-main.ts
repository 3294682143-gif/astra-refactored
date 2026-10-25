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
  validateAgentHostV14Manifest,
  type AgentHostAnyManifest,
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
  const v14Sibling = new URL("./schema/agent-host-v14.schema.json", import.meta.url);
  if (existsSync(v14Sibling)) {
    return v14Sibling;
  }
  const sibling = new URL("./schema/agent-host-v13.schema.json", import.meta.url);
  if (existsSync(sibling)) {
    return sibling;
  }
  try {
    return new URL(import.meta.resolve("@astra/protocol/schema/agent-host-v14.schema.json"));
  } catch {
    return new URL(import.meta.resolve("@astra/protocol/schema/agent-host-v13.schema.json"));
  }
}

function loadManifest(): AgentHostAnyManifest {
  const raw = JSON.parse(readFileSync(manifestUrl(), "utf8")) as Record<string, unknown>;
  if (raw["protocolVersion"] === "1.4-unified-math-assets") {
    return validateAgentHostV14Manifest(raw);
  }
  return validateAgentHostManifest(raw);
}

let started = false;

export function startAgentHost(startedAt: number = performance.now()): void {
  if (started) {
    return;
  }
  started = true;
  const manifest = loadManifest();
  const codec: HostChannelCodec<AgentHostMethod> = {
    parse: (bytes: Uint8Array) => parseAgentHostFrame(bytes, manifest as any),
    payload: (method: AgentHostMethod, side: "params" | "result", value: unknown) =>
      agentHostPayload(manifest as any, method, side, value),
  };
  const channel = new P2HostChannel<AgentHostMethod, any>(
    manifest,
    startedAt,
    codec,
  );
  const flow = new AgentHostFlow(manifest as any, {
    remainingMs: () => channel.remainingMs(),
    tighten: (ms: number) => channel.tighten(ms),
    send: (message: JsonRpcMessage, method: AgentHostMethod) => channel.send(message, method),
    stop: (message: JsonRpcMessage) => channel.stop(message),
    fail: (error: unknown) => channel.fail(error),
  });
  channel.start((message: JsonRpcMessage) => flow.handle(message));
}

// Auto-start when executed directly as script or with --agent-loop
const scriptArg = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (
  scriptArg.endsWith("agent-host-main.js") ||
  scriptArg.endsWith("agent-host-main.ts") ||
  scriptArg.endsWith("stdio-runtime.bundle.mjs") ||
  process.argv.includes("--agent-loop")
) {
  startAgentHost();
}
