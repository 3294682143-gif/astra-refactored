/**
 * @astra/stdio-runtime — P2 local Host entry point.
 *
 * Loads the single normative manifest, starts the transport channel and hands
 * every parsed message to the flow controller. No model call, no method read,
 * no network. A startup failure emits only the fixed code on stderr.
 */
import { readFileSync } from "node:fs";
import { validateP2HostManifest, type P2HostManifest } from "@astra/protocol";
import { P2HostChannel } from "./p2-host-channel.js";
import { P2HostFlow } from "./p2-host-flow.js";

function loadManifest(): P2HostManifest {
  const url = import.meta.resolve("@astra/protocol/schema/p2-host.schema.json");
  const raw = JSON.parse(readFileSync(new URL(url), "utf8")) as unknown;
  return validateP2HostManifest(raw);
}

function main(): void {
  const startedAt = performance.now();
  try {
    const manifest = loadManifest();
    const channel = new P2HostChannel(manifest, startedAt);
    const flow = new P2HostFlow(manifest, channel);
    channel.start((message) => flow.handle(message));
  } catch {
    process.stderr.write("MANIFEST_INVALID\n");
    process.exit(1);
  }
}

main();
