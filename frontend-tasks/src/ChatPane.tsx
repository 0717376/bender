import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Sparkles, Wrench } from "lucide-react";
import MicButton from "./MicButton";
import { t } from "./i18n";
import { useChat } from "./useChat";

export default function ChatPane({
  onActivity,
  collapsed,
  onToggle,
}: {
  onActivity?: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { messages, streaming, busy, send } = useChat(onActivity);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  // Auto-grow the textarea up to a cap.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  const submit = () => {
    const t = input.trim();
    if (!t || busy) return;
    send(t);
    setInput("");
  };

  const onTranscription = (text: string) => {
    setInput((v) => (v ? v.trimEnd() + " " + text : text));
    taRef.current?.focus();
  };

  if (collapsed) {
    return (
      <button className="chat-rail" onClick={onToggle} aria-label={t("open_assistant")}>
        <span className="logo"><Sparkles size={15} strokeWidth={2.4} /></span>
      </button>
    );
  }

  const empty = messages.length === 0 && !streaming;

  return (
    <section className="chat-pane">
      <div className="chat-head">
        <span className="chat-brand">
          <span className="logo"><Sparkles size={14} strokeWidth={2.4} /></span>
          <span className="chat-title">{t("assistant")}</span>
        </span>
        <div className="chat-actions">
          <button className="chat-clear" onClick={() => send("/clear")} title={t("clear_context")}>{t("clear")}</button>
          <button className="chat-collapse" onClick={onToggle} aria-label={t("collapse")}>
            <ChevronRight size={17} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="chat-log scroll" ref={scrollRef}>
        {empty && (
          <div className="chat-empty">
            {t("chat_empty_1")}
            <br />
            {t("chat_empty_2")}
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} text={m.text} tools={m.tools} />
        ))}
        {streaming && <Bubble role="assistant" text={streaming.text} tools={streaming.tools} live />}
      </div>

      <div className="chat-foot">
        <div className="chat-inputrow">
          <textarea
            ref={taRef}
            rows={1}
            placeholder={t("ask_assistant")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <MicButton onTranscription={onTranscription} />
          <button className="chat-send" type="button" disabled={busy || !input.trim()} onClick={submit} aria-label={t("send")}>
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </section>
  );
}

function Bubble({ role, text, tools, live }: { role: string; text: string; tools?: string[]; live?: boolean }) {
  return (
    <div className={"bubble " + role}>
      {tools && tools.length > 0 && (
        <div className="tools">
          {tools.map((t, i) => (
            <span className="tool" key={i}>
              <Wrench size={11} strokeWidth={2} />
              {t}
            </span>
          ))}
        </div>
      )}
      {text && <div className="text">{text}</div>}
      {live && !text && <div className="dots"><span /><span /><span /></div>}
    </div>
  );
}
