import { Volume2 } from "lucide-react";
import { pieces } from "./cloze";
import { t } from "./i18n";
import type { Card, Fields, Kind } from "./types";

const f = (fields: Fields, key: string): string => {
  const v = fields[key];
  return typeof v === "string" ? v : "";
};

/** Произнести слово голосом браузера. Язык — из карточки: английское слово русским
    голосом звучит как пародия. */
export function speak(text: string, lang: string) {
  const synth = window.speechSynthesis;
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = { en: "en-US", de: "de-DE", fr: "fr-FR", es: "es-ES", it: "it-IT" }[lang] ?? lang ?? "en-US";
  u.rate = 0.92;
  synth.speak(u);
}

/** Предложение-пример с выделенным словом — или с прочерком на его месте. */
function Example({ text, word, hide }: { text: string; word: string; hide?: boolean }) {
  if (!text) return null;
  const at = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (at < 0) return <p className="cf-example">{text}</p>;
  return (
    <p className="cf-example">
      {text.slice(0, at)}
      {hide ? <span className="cf-gap" /> : <mark>{text.slice(at, at + word.length)}</mark>}
      {text.slice(at + word.length)}
    </p>
  );
}

function Cloze({ text, n, open }: { text: string; n: number; open: boolean }) {
  return (
    <p className="cf-cloze">
      {pieces(text).map((p, i) => {
        if ("text" in p) return <span key={i}>{p.text}</span>;
        if (p.n !== n) return <span key={i}>{p.answer}</span>;
        return open
          ? <mark key={i}>{p.answer}</mark>
          : <span key={i} className="cf-blank">{p.hint || "…"}</span>;
      })}
    </p>
  );
}

/** Содержимое карточки: вопрос всегда, ответ — когда открыт. Рисуем по полям, а не по
    готовому тексту: у слова, вопроса и пропуска разная вёрстка. */
export default function CardFace({ kind, fields, tpl, source, open }: {
  kind: Kind; fields: Fields; tpl: string; source?: Card["source"]; open: boolean;
}) {
  if (kind === "word") {
    const word = f(fields, "word"), meaning = f(fields, "meaning");
    const lang = f(fields, "lang") || "en";
    const lemma = f(fields, "lemma");
    const from = source?.title ? [source.title, source.chapter].filter(Boolean).join(" · ") : "";
    const head = (
      <div className="cf-word">
        <span className="cf-term">{word}</span>
        <button className="cf-say" onClick={(e) => { e.stopPropagation(); speak(word, lang); }}
          aria-label={t("say")} title={t("say")}>
          <Volume2 size={17} strokeWidth={2} />
        </button>
      </div>
    );
    const details = (
      <div className="cf-details">
        {f(fields, "ipa") && <span className="cf-ipa">{f(fields, "ipa")}</span>}
        {f(fields, "pos") && <span className="cf-pos">{f(fields, "pos")}</span>}
        {lemma && lemma.toLowerCase() !== word.toLowerCase() && <span className="cf-lemma">{t("lemma")}: {lemma}</span>}
      </div>
    );
    if (tpl === "rev") {
      return (
        <>
          <div className="cf-q">
            <div className="cf-hint">{t("recall_word")}</div>
            <div className="cf-meaning big">{meaning}</div>
            <Example text={f(fields, "example")} word={word} hide={!open} />
          </div>
          {open && (
            <div className="cf-a">
              {head}
              {details}
              {from && <div className="cf-from">{from}</div>}
            </div>
          )}
        </>
      );
    }
    return (
      <>
        <div className="cf-q">
          {head}
          <Example text={f(fields, "example")} word={word} />
        </div>
        {open && (
          <div className="cf-a">
            <div className="cf-meaning">{meaning}</div>
            {details}
            {f(fields, "other") && <div className="cf-other">{f(fields, "other")}</div>}
            {f(fields, "example_tr") && <p className="cf-tr">{f(fields, "example_tr")}</p>}
            {from && <div className="cf-from">{from}</div>}
          </div>
        )}
      </>
    );
  }

  if (kind === "cloze") {
    const n = Number(tpl.slice(1)) || 1;
    return (
      <>
        <div className="cf-q"><Cloze text={f(fields, "text")} n={n} open={open} /></div>
        {open && f(fields, "extra") && <div className="cf-a"><p className="cf-text">{f(fields, "extra")}</p></div>}
      </>
    );
  }

  const [q, a] = tpl === "rev" ? [f(fields, "back"), f(fields, "front")] : [f(fields, "front"), f(fields, "back")];
  return (
    <>
      <div className="cf-q"><p className="cf-text big">{q}</p></div>
      {open && (
        <div className="cf-a">
          <p className="cf-text answer">{a}</p>
          {f(fields, "extra") && <p className="cf-text extra">{f(fields, "extra")}</p>}
        </div>
      )}
    </>
  );
}
