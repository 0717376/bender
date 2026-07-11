import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "./api";

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: string[];
}

interface Streaming {
  id: string;
  text: string;
  tools: string[];
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
          s.text = (s.text ? s.text + "\n\n" : "") + "⚠ " + m.text;
          streamRef.current = { ...s };
          setStreaming(streamRef.current);
        } else if (m.t === "done") {
          const s = streamRef.current;
          if (s && (s.text || s.tools.length)) {
            setMessages((prev) => [...prev, { id: s.id || crypto.randomUUID(), role: "assistant", text: s.text, tools: s.tools }]);
          }
          streamRef.current = null;
          setStreaming(null);
          setBusy(false);
          onActivity?.();
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
      };
    });
  }, [onActivity]);

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
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", text: "⚠ Нет связи с ассистентом." }]);
      }
    },
    [busy, connect],
  );

  useEffect(() => () => wsRef.current?.close(), []);

  return { messages, streaming, busy, send };
}
