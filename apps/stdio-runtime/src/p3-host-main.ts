/**
 * @astra/stdio-runtime — P3 local Host entry point.
 *
 * Loads the single P3 Host manifest, binds the existing single-reader
 * `P2HostChannel` to a P3 codec and forwards every frame to `P3HostFlow`.
 * No second reader, framing or JSON parser is introduced here.
 */
import { readFileSync } from "node:fs";
import {
  parseP3HostFrame,
  p3HostPayload,
  validateP3HostManifest,
  type JsonRpcMessage,
  type P3HostManifest,
  type P3HostMethod,
} from "@astra/protocol";
import { P2HostChannel, type HostChannelCodec } from "./p2-host-channel.js";
import { P3HostFlow } from "./p3-host-flow.js";

function loadManifest(): P3HostManifest {
  const MANIFEST_URL = new URL(
    import.meta.resolve("@astra/protocol/schema/p3-host.schema.json"),
  );
  const raw = JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as unknown;
  return validateP3HostManifest(raw);
}

function main(): void {
  const startedAt = performance.now();
  const manifest = loadManifest();
  const codec: HostChannelCodec<P3HostMethod> = {
    parse: (bytes: Uint8Array) => parseP3HostFrame(bytes, manifest),
    payload: (method: P3HostMethod, side: "params" | "result", value: unknown) =>
      p3HostPayload(manifest, method, side, value),
  };
  const channel = new P2HostChannel<P3HostMethod, P3HostManifest>(manifest, startedAt, codec);
  const flow = new P3HostFlow(manifest, {
    remainingMs: () => channel.remainingMs(),
    tighten: (ms: number) => channel.tighten(ms),
    send: (message: JsonRpcMessage, method: P3HostMethod) => channel.send(message, method),
    stop: (message: JsonRpcMessage) => channel.stop(message),
  });
  channel.start((message: JsonRpcMessage) => flow.handle(message));
}

try {
  main();
} catch {
  process.stderr.write("MANIFEST_INVALID\n");
  process.exit(1);
}
