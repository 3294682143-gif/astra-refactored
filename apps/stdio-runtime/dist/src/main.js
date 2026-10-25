/**
 * Node stdio entry point with two explicit profiles.
 *
 * Default (no argument): the P0 probe. One reader pumps stdin; phases are
 * init -> probe -> catalog -> stop -> stopping. While a catalog callback is
 * pending, every host request is refused. stdout carries NDJSON only; stderr
 * carries fixed codes only. This profile is not a math AgentLoop: no model
 * call, no tool call, no solve path, and its only outbound request is the
 * read-only `method.catalog` callback.
 *
 * `--agent-loop`: the unified AgentLoop local Host profile. It dynamically
 * imports `startAgentHost`, which loads the Agent Host manifest and drives
 * `AgentHostFlow` over the same single-reader channel. The P0 probe logic
 * below is unchanged and remains the default.
 */
import { readFileSync } from "node:fs";
import { ERROR_CODES, LIMITS, PROTOCOL_VERSION, checkBinding, classifyMethod, parseFrame, validateAgainstSchema, validateManifest, } from "@astra/protocol";
const DEADLINE_MS = 5000;
const MAX_FRAMES = LIMITS.maxFramesPerSession;
const MAX_FRAME_BYTES = LIMITS.maxFrameBytes;
const EXPECTED_CATALOG = 20;
const STARTED_AT = performance.now();
function loadManifest() {
    const url = import.meta.resolve("@astra/protocol/schema/p0.schema.json");
    const raw = JSON.parse(readFileSync(new URL(url), "utf8"));
    const checked = validateManifest(raw);
    if (!checked.ok) {
        throw new Error(checked.code);
    }
    return checked.value;
}
class Probe {
    manifest;
    timer;
    buffer = Buffer.alloc(0);
    frames = 0;
    phase = "init";
    sessionId = null;
    nextId = 1;
    hostIds = new Set();
    callbackId = null;
    pendingProbeId = null;
    pendingNonce = null;
    stopped = false;
    constructor(manifest) {
        this.manifest = manifest;
        const remaining = Math.max(1, DEADLINE_MS - (performance.now() - STARTED_AT));
        this.timer = setTimeout(() => this.fail("DEADLINE_EXCEEDED"), remaining);
    }
    start() {
        process.stdin.on("data", (chunk) => this.onData(chunk));
        process.stdin.on("end", () => this.onEnd());
        process.stdin.on("error", () => this.fail(ERROR_CODES.EOF));
        process.stdout.on("error", () => this.fail(ERROR_CODES.EOF));
        process.stderr.on("error", () => process.exit(1));
        process.stdin.resume();
    }
    expired() {
        return performance.now() - STARTED_AT >= DEADLINE_MS;
    }
    onData(chunk) {
        if (this.expired()) {
            this.fail("DEADLINE_EXCEEDED");
            return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const index = this.buffer.indexOf(0x0a);
            if (index < 0) {
                if (this.buffer.byteLength > MAX_FRAME_BYTES) {
                    this.fail(ERROR_CODES.FRAME_TOO_LARGE);
                }
                return;
            }
            const line = this.buffer.subarray(0, index);
            this.buffer = this.buffer.subarray(index + 1);
            if (line.byteLength > MAX_FRAME_BYTES) {
                this.fail(ERROR_CODES.FRAME_TOO_LARGE);
                return;
            }
            this.frames += 1;
            if (this.frames > MAX_FRAMES) {
                this.fail(ERROR_CODES.FRAME_LIMIT_EXCEEDED);
                return;
            }
            if (line.byteLength === 0) {
                this.fail(ERROR_CODES.INVALID_JSON);
                return;
            }
            const parsed = parseFrame(line, this.manifest);
            if (!parsed.ok) {
                this.fail(parsed.code);
                return;
            }
            this.dispatch(parsed.value);
            if (this.phase === "stopping") {
                // A stop ack ends the session. Any further bytes already buffered in
                // the same chunk are a protocol violation, not silently discarded.
                if (this.buffer.byteLength > 0) {
                    this.fail(ERROR_CODES.FIELD_VALUE);
                }
                return;
            }
        }
    }
    onEnd() {
        this.fail(ERROR_CODES.EOF);
    }
    dispatch(message) {
        if ("method" in message) {
            this.onRequest(message.id, message.method, message.params);
            return;
        }
        if ("result" in message) {
            this.onResult(message.id, message.result);
            return;
        }
        this.fail(ERROR_CODES.FIELD_VALUE);
    }
    onRequest(id, method, params) {
        if (id.startsWith("node-")) {
            this.fail(ERROR_CODES.ID_MISMATCH);
            return;
        }
        if (this.hostIds.has(id)) {
            this.fail(ERROR_CODES.ID_MISMATCH);
            return;
        }
        this.hostIds.add(id);
        const classified = classifyMethod(method);
        if (!classified.ok) {
            this.fail(classified.code);
            return;
        }
        if (this.phase === "catalog") {
            this.fail(ERROR_CODES.FIELD_VALUE);
            return;
        }
        if (this.phase === "init") {
            if (classified.value !== "runtime.initialize") {
                this.fail(ERROR_CODES.FIELD_VALUE);
                return;
            }
            this.handleInitialize(id, params);
            return;
        }
        if (this.phase === "probe") {
            if (classified.value !== "runtime.probe") {
                this.fail(ERROR_CODES.FIELD_VALUE);
                return;
            }
            this.handleProbe(id, params);
            return;
        }
        if (this.phase === "stop") {
            if (classified.value !== "session.stop") {
                this.fail(ERROR_CODES.FIELD_VALUE);
                return;
            }
            this.handleStop(id, params);
            return;
        }
        this.fail(ERROR_CODES.FIELD_VALUE);
    }
    checkParams(method, params) {
        const spec = this.manifest.methods[method];
        if (spec === undefined) {
            return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: method };
        }
        const checked = validateAgainstSchema(params, spec.params);
        if (!checked.ok) {
            return checked;
        }
        if (method === "runtime.initialize") {
            return { ok: true, value: null };
        }
        return checkBinding(params, this.sessionId ?? "");
    }
    handleInitialize(id, params) {
        const checked = this.checkParams("runtime.initialize", params);
        if (!checked.ok) {
            this.fail(checked.code);
            return;
        }
        const sessionId = params["sessionId"];
        if (typeof sessionId !== "string") {
            this.fail(ERROR_CODES.FIELD_TYPE);
            return;
        }
        this.sessionId = sessionId;
        this.phase = "probe";
        this.send({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: PROTOCOL_VERSION,
                sessionId,
                nodeCapabilities: {
                    mathModelCalls: "UNAVAILABLE",
                    publicOutputLimit: "UNVERIFIED",
                    wasi: "DISABLED",
                    nativeToolCalls: "UNAVAILABLE",
                },
            },
        }, "runtime.initialize");
    }
    handleProbe(id, params) {
        const checked = this.checkParams("runtime.probe", params);
        if (!checked.ok) {
            this.fail(checked.code);
            return;
        }
        const nonce = params["nonce"];
        if (typeof nonce !== "string") {
            this.fail(ERROR_CODES.FIELD_TYPE);
            return;
        }
        this.pendingProbeId = id;
        this.pendingNonce = nonce;
        this.phase = "catalog";
        const callbackId = `node-${this.nextId}`;
        this.nextId += 1;
        this.callbackId = callbackId;
        this.send({
            jsonrpc: "2.0",
            id: callbackId,
            method: "method.catalog",
            params: { protocolVersion: PROTOCOL_VERSION, sessionId: this.sessionId },
        }, "method.catalog");
    }
    onResult(id, result) {
        if (this.phase !== "catalog" || this.callbackId === null || id !== this.callbackId) {
            this.fail(ERROR_CODES.ID_MISMATCH);
            return;
        }
        const spec = this.manifest.methods["method.catalog"];
        if (spec === undefined) {
            this.fail(ERROR_CODES.MANIFEST_INVALID);
            return;
        }
        const checked = validateAgainstSchema(result, spec.result);
        if (!checked.ok) {
            this.fail(checked.code);
            return;
        }
        const bound = checkBinding(result, this.sessionId ?? "");
        if (!bound.ok) {
            this.fail(bound.code);
            return;
        }
        const entries = result["entries"];
        if (!Array.isArray(entries) || entries.length !== EXPECTED_CATALOG) {
            this.fail(ERROR_CODES.FIELD_VALUE);
            return;
        }
        const seen = new Set();
        for (const entry of entries) {
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
                this.fail(ERROR_CODES.FIELD_TYPE);
                return;
            }
            const row = entry;
            const entryId = row["id"];
            if (typeof entryId !== "string" || seen.has(entryId)) {
                this.fail(ERROR_CODES.FIELD_VALUE);
                return;
            }
            seen.add(entryId);
        }
        const probeId = this.pendingProbeId;
        const nonce = this.pendingNonce;
        this.pendingProbeId = null;
        this.pendingNonce = null;
        this.callbackId = null;
        if (probeId === null || nonce === null) {
            this.fail(ERROR_CODES.FIELD_VALUE);
            return;
        }
        this.phase = "stop";
        this.send({
            jsonrpc: "2.0",
            id: probeId,
            result: {
                protocolVersion: PROTOCOL_VERSION,
                sessionId: this.sessionId,
                nonce,
                catalogCount: entries.length,
                catalogAcknowledged: true,
            },
        }, "runtime.probe");
    }
    handleStop(id, params) {
        const checked = this.checkParams("session.stop", params);
        if (!checked.ok) {
            this.fail(checked.code);
            return;
        }
        this.phase = "stopping";
        this.send({
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: PROTOCOL_VERSION, sessionId: this.sessionId, stopped: true },
        }, "session.stop", () => {
            this.stopped = true;
            clearTimeout(this.timer);
            process.exit(0);
        });
    }
    send(message, method, onFlushed) {
        if (this.expired()) {
            this.fail("DEADLINE_EXCEEDED");
            return;
        }
        const spec = this.manifest.methods[method];
        if (spec === undefined) {
            this.fail(ERROR_CODES.MANIFEST_INVALID);
            return;
        }
        if ("error" in message) {
            this.fail(ERROR_CODES.FIELD_VALUE);
            return;
        }
        const payload = "method" in message ? message.params : message.result;
        const node = "method" in message ? spec.params : spec.result;
        const checked = validateAgainstSchema(payload, node);
        if (!checked.ok) {
            this.fail(checked.code);
            return;
        }
        const line = `${JSON.stringify(message)}\n`;
        const envelope = parseFrame(Buffer.from(line.slice(0, -1), "utf8"), this.manifest);
        if (!envelope.ok) {
            this.fail(envelope.code);
            return;
        }
        this.frames += 1;
        if (this.frames > MAX_FRAMES) {
            this.fail(ERROR_CODES.FRAME_LIMIT_EXCEEDED);
            return;
        }
        if (Buffer.byteLength(line, "utf8") - 1 > MAX_FRAME_BYTES) {
            this.fail(ERROR_CODES.FRAME_TOO_LARGE);
            return;
        }
        process.stdout.write(line, (error) => {
            if (error) {
                this.fail(ERROR_CODES.EOF);
                return;
            }
            if (onFlushed !== undefined) {
                onFlushed();
            }
        });
    }
    fail(code) {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        clearTimeout(this.timer);
        process.stderr.write(`${code}\n`);
        process.exit(1);
    }
}
function main() {
    let manifest;
    try {
        manifest = loadManifest();
    }
    catch {
        process.stderr.write(`${ERROR_CODES.MANIFEST_INVALID}\n`);
        process.exit(1);
        return;
    }
    new Probe(manifest).start();
}
const argv = process.argv;
const scriptArg = argv[1] ? argv[1].replace(/\\/g, "/") : "";
const isBundle = scriptArg.endsWith("stdio-runtime.bundle.mjs");
if (argv.length === 2) {
    if (isBundle) {
        import("./agent-host-main.js")
            .then((module) => {
            module.startAgentHost(STARTED_AT);
        })
            .catch(() => {
            process.stderr.write(`${ERROR_CODES.FIELD_VALUE}\n`);
            process.exit(1);
        });
    }
    else {
        main();
    }
}
else if (argv.length === 3 && argv[2] === "--agent-loop") {
    import("./agent-host-main.js")
        .then((module) => {
        module.startAgentHost(STARTED_AT);
    })
        .catch(() => {
        process.stderr.write(`${ERROR_CODES.FIELD_VALUE}\n`);
        process.exit(1);
    });
}
else {
    process.stderr.write(`${ERROR_CODES.FIELD_VALUE}\n`);
    process.exit(1);
}
