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
import { agentHostPayload, parseAgentHostFrame, validateAgentHostV14Manifest, } from "@astra/protocol";
import { P2HostChannel } from "./p2-host-channel.js";
import { AgentHostFlow } from "./agent-host-flow.js";
/**
 * The manifest URL. A self-contained precompiled bundle ships the schema next
 * to it (`./schema/...`); a normal in-repo build falls back to the workspace
 * package export. This keeps the bundle runnable without node_modules.
 */
function manifestUrl() {
    // The active entry is the unified v1.4 runtime. A missing v1.4 schema must
    // fail closed: silently loading the v1.3 sibling turns a packaging error into
    // a mixed-version run (Python sends v1.4 initialize, Node answers with a v1.3
    // FIELD_VALUE, and the Host reports an empty-stream EOF).
    const v14Sibling = new URL("./schema/agent-host-v14.schema.json", import.meta.url);
    if (existsSync(v14Sibling)) {
        return v14Sibling;
    }
    return new URL(import.meta.resolve("@astra/protocol/schema/agent-host-v14.schema.json"));
}
function loadManifest() {
    const raw = JSON.parse(readFileSync(manifestUrl(), "utf8"));
    if (raw["protocolVersion"] !== "1.4-unified-math-assets") {
        throw new Error("VERSION_MISMATCH");
    }
    return validateAgentHostV14Manifest(raw);
}
let started = false;
export function startAgentHost(startedAt = performance.now()) {
    if (started) {
        return;
    }
    started = true;
    const manifest = loadManifest();
    const codec = {
        parse: (bytes) => parseAgentHostFrame(bytes, manifest),
        payload: (method, side, value) => agentHostPayload(manifest, method, side, value),
    };
    const channel = new P2HostChannel(manifest, startedAt, codec);
    const flow = new AgentHostFlow(manifest, {
        remainingMs: () => channel.remainingMs(),
        tighten: (ms) => channel.tighten(ms),
        send: (message, method) => channel.send(message, method),
        stop: (message) => channel.stop(message),
        fail: (error) => channel.fail(error),
    });
    channel.start((message) => flow.handle(message));
}
// Auto-start when executed directly as script or with --agent-loop
const scriptArg = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (scriptArg.endsWith("agent-host-main.js") ||
    scriptArg.endsWith("agent-host-main.ts") ||
    scriptArg.endsWith("stdio-runtime.bundle.mjs") ||
    process.argv.includes("--agent-loop")) {
    startAgentHost();
}
