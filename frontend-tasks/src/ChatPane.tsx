import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Loader2, Paperclip, Sparkles, TriangleAlert, Wrench } from "lucide-react";
import MicButton from "./MicButton";
import { filesLabel, t } from "./i18n";
import { useChat } from "./useChat";
import { storageParsePrompt, storageUpload } from "./api";

// Скрепка кладёт файл в общий inbox — ту же папку, куда падает всё, что пришло
// боту в Telegram. Один поток входящих на всё приложение.
const ATTACH_DIR = "Входящие";

export default function ChatPane({
  onActivity,
  notify,
  collapsed,
  onToggle,
}: {
  onActivity?: () => void;
  notify: (text: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { messages, streaming, busy, send } = useChat(onActivity);
  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  // Файлы ложатся во «Входящие», затем агенту уходит одна просьба разобрать их все:
  // чат ведёт один ход за раз, второе сообщение упёрлось бы в незаконченный ответ.
  const onAttach = async (files: FileList | null) => {
    if (!files?.length || uploading || busy) return;
    setUploading(true);
    const paths: string[] = [], names: string[] = [];
    try {
      for (const f of Array.from(files)) {
        try {
          paths.push(await storageUpload(ATTACH_DIR, f));
          names.push(f.name);
        } catch (e) {
          notify(`${f.name}: ${(e as Error).message}`);
        }
      }
      if (paths.length) send(await storageParsePrompt(paths), filesLabel(names));
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
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
          <Bubble key={m.id} role={m.role} text={m.text} tools={m.tools} error={m.error} />
        ))}
        {streaming && <Bubble role="assistant" text={streaming.text} tools={streaming.tools} error={streaming.error} live />}
      </div>

      <div className="chat-foot">
        <div className="chat-inputrow">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => onAttach(e.target.files)}
          />
          <button
            className="chat-attach"
            type="button"
            disabled={busy || uploading}
            onClick={() => fileRef.current?.click()}
            aria-label={t("attach_file")}
            title={t("attach_file")}
          >
            {uploading ? <Loader2 size={16} className="spin" /> : <Paperclip size={16} strokeWidth={2} />}
          </button>
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

function Bubble({ role, text, tools, live, error }: { role: string; text: string; tools?: string[]; live?: boolean; error?: boolean }) {
  return (
    <div className={"bubble " + role + (error ? " error" : "")}>
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
      {text && (
        <div className="text">
          {error && <TriangleAlert size={13} strokeWidth={2.2} />}
          {text}
        </div>
      )}
      {live && !text && <div className="dots"><span /><span /><span /></div>}
    </div>
  );
}
