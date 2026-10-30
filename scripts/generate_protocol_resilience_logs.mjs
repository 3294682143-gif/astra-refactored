// scripts/generate_protocol_resilience_logs.mjs
// 生成 K13 三矩阵（T25 断线重连、T21 节流/5xx、409 冲突恢复）真实离线审计日志到 var/astra/protocol/*.jsonl

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dataRoot = path.join(repoRoot, "var", "astra");
process.env.ASTRA_DATA_ROOT = dataRoot;

const bridgeModule = await import("../../inkstone-re-lab/src/desktop/atria-bridge-runner.mjs");
const { executeWithRecovery } = bridgeModule;

function sseResponse(events, { status = 200, headers = {} } = {}) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

function withStubbedFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

const GOOD_EVENTS = [
  { type: "message_start", response_id: "resp-good-p2", model: "Atria-Dawn" },
  { type: "thinking_delta", text: "协议韧性恢复分析中..." },
  { type: "content_delta", text: "推理恢复成功，状态一致。" },
  { type: "usage", usage: { input_tokens: 18, output_tokens: 8, cache_read_tokens: 0, cache_write_tokens: 0 } },
  { type: "message_end", stop_reason: "end_turn" },
];

async function main() {
  const protocolDir = path.join(dataRoot, "protocol");
  fs.mkdirSync(protocolDir, { recursive: true });

  console.log(`Writing protocol resilience logs to: ${protocolDir}`);

  // 1. T25 SSE 断线重连
  let t25Calls = 0;
  await withStubbedFetch(
    async () => {
      t25Calls++;
      return t25Calls === 1
        ? sseResponse([
            { type: "message_start", response_id: "resp-broken", model: "Atria-Dawn" },
            { type: "thinking_delta", text: "网络抖动中断..." },
          ])
        : sseResponse(GOOD_EVENTS);
    },
    async () => {
      await executeWithRecovery(
        {
          sessionId: "sess_k13_t25_reconnect",
          requestId: "req_t25_demo",
          messages: [{ role: "user", content: "T25断线重连" }],
          allowSseReconnect: true,
        },
        { registerSigterm: false }
      );
    }
  );

  // 2. T21 429 节流
  await withStubbedFetch(
    async () =>
      new Response(
        JSON.stringify({
          code: 429000,
          data: { reason: "RATE_LIMIT_EXCEEDED" },
          synthetic: true,
        }),
        {
          status: 429,
          headers: new Headers({
            "Retry-After": "3",
            "x-rpm-limit": "60",
            "x-rpm-remaining": "0",
            "X-Synthetic-Fault": "true",
          }),
        }
      ),
    async () => {
      try {
        await executeWithRecovery(
          {
            sessionId: "sess_k13_t21_throttle429",
            requestId: "req_t21_429",
            messages: [{ role: "user", content: "T21节流" }],
          },
          { registerSigterm: false }
        );
      } catch (err) {}
    }
  );

  // 3. 409 冲突恢复成功
  let cCalls = 0;
  await withStubbedFetch(
    async () => {
      cCalls++;
      return cCalls === 1
        ? new Response(
            JSON.stringify({
              code: 409001,
              data: { reason: "TURN_CONFLICT" },
              synthetic: true,
            }),
            { status: 409 }
          )
        : sseResponse(GOOD_EVENTS);
    },
    async () => {
      await executeWithRecovery(
        {
          sessionId: "sess_k13_conflict409_retry",
          requestId: "req_409_retry",
          messages: [{ role: "user", content: "409恢复" }],
          recoveryProof: { drainedAt: Date.now() - 300, requestId: "req_prior" },
        },
        { registerSigterm: false }
      );
    }
  );

  // 4. 409 冲突不可恢复（无凭据诚实阻断）
  await withStubbedFetch(
    async () =>
      new Response(
        JSON.stringify({
          code: 409001,
          data: { reason: "TURN_CONFLICT" },
          synthetic: true,
        }),
        { status: 409 }
      ),
    async () => {
      try {
        await executeWithRecovery(
          {
            sessionId: "sess_k13_conflict409_unrecoverable",
            requestId: "req_409_fail",
            messages: [{ role: "user", content: "409不可恢复" }],
          },
          { registerSigterm: false }
        );
      } catch (err) {}
    }
  );

  const files = fs.readdirSync(protocolDir).filter((f) => f.endsWith(".jsonl"));
  console.log(`Generated ${files.length} protocol log files:`);
  for (const f of files) {
    const p = path.join(protocolDir, f);
    const content = fs.readFileSync(p, "utf8");
    const kinds = [
      ...new Set(
        content
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l).kind)
      ),
    ];
    console.log(` - ${f} (${fs.statSync(p).size}B) kinds: [${kinds.join(", ")}]`);
  }
}

main().catch(console.error);
