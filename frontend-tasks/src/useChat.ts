import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "./api";
import { t as tr } from "./i18n"; // alias: `t` is a local variable inside send()

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  error?: boolean;
}

interface Streaming {
  id: string;
  text: string;
  tools: string[];
  error?: boolean;
}

type ToolEvent = { name: string; pattern?: string; file?: string };

function toolLabel(e: ToolEvent): string {
  const detail = e.file || e.pattern || "";
  const name = e.name.replace(/^mcp__tasks__/, "");
  return detail ? `${name}: ${detail}` : name;
}

export function useChat(onActivity?: () => void) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [busy, setBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<Streaming | null>(null);

  /** Переложить то, что накопилось в потоке, в историю и разблокировать ввод. */
  const flush = useCallback(() => {
    const s = streamRef.current;
    if (s && (s.text || s.tools.length)) {
      setMessages((prev) => [...prev, {
        id: s.id || crypto.randomUUID(), role: "assistant", text: s.text, tools: s.tools, error: s.error,
      }]);
    }
    streamRef.current = null;
    setStreaming(null);
    setBusy(false);
  }, []);

  const connect = useCallback((): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const existing = wsRef.current;
      if (existing && existing.readyState === WebSocket.OPEN) return resolve(existing);
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/chat/ws?token=${getToken()}&surface=tasks`);
      wsRef.current = ws;
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("ws error"));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === "text") {
          const s = streamRef.current ?? { id: m.id, text: "", tools: [] };
          s.id = m.id || s.id;
          s.text = m.text;
          streamRef.current = { ...s };
          setStreaming(streamRef.current);
        } else if (m.t === "tool") {
          const s = streamRef.current ?? { id: "t", text: "", tools: [] };
          s.tools = [...s.tools, toolLabel(m)];
          streamRef.current = { ...s };
          setStreaming(streamRef.current);
          onActivity?.();
        } else if (m.t === "error") {
          const s = streamRef.current ?? { id: "e", text: "", tools: [] };
          s.text = (s.text ? s.text + "\n\n" : "") + m.text;
          s.error = true;
          streamRef.current = { ...s };
          setStreaming(streamRef.current);
        } else if (m.t === "done") {
          flush();
          onActivity?.();
        }
      };
      // Обрыв посреди ответа: без этого индикатор «печатает» крутился бы вечно,
      // а поле ввода оставалось заблокированным.
      ws.onclose = () => {
        wsRef.current = null;
        if (streamRef.current) {
          streamRef.current = { ...streamRef.current, text: streamRef.current.text || tr("no_connection"), error: true };
        }
        flush();
      };
    });
  }, [onActivity, flush]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || busy) return;
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text: t }]);
      if (t !== "/clear") {
        setBusy(true);
        streamRef.current = { id: "", text: "", tools: [] };
        setStreaming(streamRef.current);
      } else {
        setMessages([]);
        setStreaming(null);
      }
      try {
        const ws = await connect();
        ws.send(JSON.stringify({ type: "message", text: t, context: {} }));
      } catch {
        setBusy(false);
        setStreaming(null);
        streamRef.current = null;
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", text: tr("no_connection"), error: true }]);
      }
    },
    [busy, connect],
  );

  useEffect(() => () => wsRef.current?.close(), []);

  return { messages, streaming, busy, send };
}
