import { useEffect, useRef, useState } from "react";
import { Brain, Send, Square, Zap } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";

/**
 * 产品形态对话页（product-chat-showcase 演示通道）。
 *
 * 诚实红线：
 *  1. 本页不产生求解证书，不经过 /api/runs 求解架构；
 *  2. 每条消息尾注如实标注服务端是否下发了 reasoning（reasoning_dispatched）；
 *  3. 「停止生成」只触发服务端本地中止句柄，远端终态未知时明示「远端状态未知」，
 *     绝不冒充服务端已停止（本地 abort ≠ 服务端停止）。
 */

interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly thinking?: string;
  readonly reasoningDispatched?: boolean;
  readonly usage?: Record<string, unknown> | null;
  readonly abortedLocally?: boolean;
  readonly errorNote?: string;
  readonly done: boolean;
}

interface SseFrame {
  readonly type?: string;
  readonly text?: string;
  readonly chat_id?: string;
  readonly reasoning_dispatched?: boolean;
  readonly remote_state?: string;
  readonly code?: string;
  readonly message?: string;
  readonly usage?: Record<string, unknown> | null;
  readonly stop_reason?: string;
  readonly synthetic?: boolean;
}

function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const dataLines = part
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) continue;
    try {
      frames.push(JSON.parse(dataLines.join("\n")) as SseFrame);
    } catch {
      // 非 JSON 帧（如 mock 网关原始事件）按原文忽略，不伪造结构
    }
  }
  return { frames, rest };
}

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinkingMode, setThinkingMode] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const updateMessage = (id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  const appendMessage = (msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  };

  const send = async () => {
    const query = input.trim();
    if (!query || streaming) return;
    setInput("");
    setStopNote(null);
    appendMessage({ id: nextId(), role: "user", content: query, done: true });
    const assistantId = nextId();
    appendMessage({ id: assistantId, role: "assistant", content: "", thinking: "", done: false });

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    try {
      const resp = await fetch("/api/atria/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ query, thinking_mode: thinkingMode, ...(chatId ? { chat_id: chatId } : {}) }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        updateMessage(assistantId, {
          done: true,
          errorNote: `HTTP ${resp.status}（响应未携带事件流，不编造内容）`,
        });
        setStreaming(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.type === "workflow_started") {
            if (typeof frame.chat_id === "string") setChatId(frame.chat_id);
            updateMessage(assistantId, { reasoningDispatched: Boolean(frame.reasoning_dispatched) });
          } else if (frame.type === "message.thinking" && typeof frame.text === "string") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, thinking: (m.thinking ?? "") + frame.text } : m,
              ),
            );
          } else if (frame.type === "message.answer" && typeof frame.text === "string") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + frame.text } : m,
              ),
            );
          } else if (frame.type === "usage") {
            updateMessage(assistantId, { usage: frame.usage ?? null });
          } else if (frame.type === "aborted_locally") {
            updateMessage(assistantId, { done: true, abortedLocally: true });
            setStopNote("已本地中止；远端生成终止状态未知（不冒充服务端已停止）。");
          } else if (frame.type === "message_end") {
            updateMessage(assistantId, { done: true });
          } else if (frame.type === "error") {
            updateMessage(assistantId, {
              done: true,
              errorNote: `${frame.code ?? "ERROR"}：${frame.message ?? "未知错误"}`,
            });
          }
        }
      }
      setMessages((prev) => prev.map((m) => (m.id === assistantId && !m.done ? { ...m, done: true } : m)));
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        updateMessage(assistantId, { done: true, abortedLocally: true });
      } else {
        updateMessage(assistantId, {
          done: true,
          errorNote: `网络错误：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = async () => {
    abortRef.current?.abort();
    if (chatId) {
      try {
        const resp = await fetch(`/api/atria/chat/${encodeURIComponent(chatId)}/stop`, { method: "POST" });
        const body = (await resp.json()) as { local_aborted?: boolean; remote_state?: string; honest_note?: string };
        setStopNote(
          body.local_aborted
            ? (body.honest_note ?? "已本地中止；远端状态未知。")
            : `会话已结束或不存在（${body.remote_state ?? "unknown"}）`,
        );
      } catch {
        setStopNote("停止请求未达服务端；本地流已中止，远端状态未知。");
      }
    }
    setStreaming(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", height: "calc(100vh - 140px)" }}>
      <section
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "14px 20px",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            产品形态对话
          </h1>
          <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginTop: "4px" }}>
            product-chat-showcase 演示通道 · 不产生求解证书 · 提供方由服务端环境决定
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>思考开关</span>
          {[
            { key: false, label: "快速", icon: Zap },
            { key: true, label: "深度", icon: Brain },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              disabled={streaming}
              onClick={() => setThinkingMode(key)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                borderRadius: "9999px",
                border: "1px solid var(--color-line)",
                padding: "5px 14px",
                fontSize: "13px",
                cursor: streaming ? "not-allowed" : "pointer",
                backgroundColor: thinkingMode === key ? "var(--color-brand)" : "var(--color-surface-muted)",
                color: thinkingMode === key ? "#fff" : "var(--color-ink-soft)",
              }}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </section>

      <section
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
      >
        {messages.length === 0 && (
          <PanelEmptyState
            title="开始一段对话"
            description="思考开关切换真实的服务端 reasoning 下发；停止生成只承诺本地中止，远端终态如实标注未知。"
          />
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
            {m.thinking && (
              <div
                style={{
                  maxWidth: "78%",
                  borderRadius: "10px",
                  border: "1px dashed var(--color-line-strong)",
                  backgroundColor: "var(--color-surface-muted)",
                  padding: "10px 14px",
                  fontSize: "12px",
                  color: "var(--color-ink-mute)",
                  marginBottom: "6px",
                  whiteSpace: "pre-wrap",
                }}
              >
                <Brain size={12} style={{ verticalAlign: "-2px", marginRight: "4px" }} />
                思考过程：{m.thinking}
              </div>
            )}
            <div
              style={{
                maxWidth: "78%",
                borderRadius: "10px",
                padding: "10px 14px",
                fontSize: "14px",
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
                backgroundColor: m.role === "user" ? "var(--color-brand)" : "var(--color-surface-muted)",
                color: m.role === "user" ? "#fff" : "var(--color-ink)",
                border: m.role === "user" ? "none" : "1px solid var(--color-line)",
              }}
            >
              {m.content || (m.done ? "" : "…")}
              {m.errorNote && (
                <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-danger, #b00)" }}>
                  {m.errorNote}
                </div>
              )}
            </div>
            <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--color-ink-mute)" }}>
              {m.role === "assistant" && m.reasoningDispatched !== undefined && (
                <span>reasoning_dispatched={String(m.reasoningDispatched)} · </span>
              )}
              {m.abortedLocally && <span>已本地中止，远端状态未知 · </span>}
              {m.usage && <span>usage={JSON.stringify(m.usage)}</span>}
            </div>
          </div>
        ))}
      </section>

      {stopNote && (
        <div
          role="status"
          style={{
            borderRadius: "10px",
            border: "1px solid var(--color-line-strong)",
            backgroundColor: "var(--color-surface-muted)",
            padding: "10px 16px",
            fontSize: "12px",
            color: "var(--color-ink-soft)",
          }}
        >
          {stopNote}
        </div>
      )}

      <section
        style={{
          display: "flex",
          gap: "10px",
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "14px 16px",
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void send();
          }}
          placeholder="输入问题，Enter 发送"
          disabled={streaming}
          style={{
            flex: 1,
            borderRadius: "8px",
            border: "1px solid var(--color-line)",
            padding: "10px 14px",
            fontSize: "14px",
            outline: "none",
            backgroundColor: "var(--color-surface-muted)",
            color: "var(--color-ink)",
          }}
        />
        {streaming ? (
          <button
            type="button"
            onClick={() => void stop()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              borderRadius: "8px",
              border: "1px solid var(--color-line-strong)",
              backgroundColor: "var(--color-surface-muted)",
              color: "var(--color-ink)",
              padding: "10px 18px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Square size={14} />
            停止生成
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: "var(--color-brand)",
              color: "#fff",
              padding: "10px 18px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: input.trim() ? "pointer" : "not-allowed",
              opacity: input.trim() ? 1 : 0.5,
            }}
          >
            <Send size={14} />
            发送
          </button>
        )}
      </section>
    </div>
  );
}
