import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { api } from "./api";
import { exName, mins, restText } from "./fmt";
import GuideModal from "./Guide";
import { useBook } from "./guides";
import { t } from "./i18n";
import { KIND_ICON } from "./Today";
import type { Program as Prog } from "./types";

/** Программа как она есть. Меняет её ассистент: правка одной строки тянет за собой остальные
    (объём на мышцу, время тренировки), и считать это руками — не то, зачем приложение. */
export default function Program({ version, nextId, onAsk }: {
  version: number; nextId: number | null; onAsk: (text: string) => void;
}) {
  const [p, setP] = useState<Prog | null | undefined>(undefined);
  const [guide, setGuide] = useState<{ id: number; name: string } | null>(null);
  const book = useBook();
  useEffect(() => { api.program().then(setP).catch(() => setP(null)); }, [version]);
  if (p === undefined) return <div className="rv-loading"><span className="spin" /></div>;
  if (!p) {
    return (
      <div className="empty-big">
        <p>{t("no_program_hint")}</p>
        <button className="btn primary big" onClick={() => onAsk(t("ask_program"))}><Sparkles size={17} />{t("ask_program_btn")}</button>
      </div>
    );
  }
  return (
    <>
      <div className="prog-head">
        <h2>{p.name}</h2>
        {p.goal && <p>{p.goal}</p>}
        {p.note && <p className="muted">{p.note}</p>}
      </div>
      <div className="prog-days">
        {p.days.map((d) => {
          const Icon = KIND_ICON[d.kind];
          return (
            <section key={d.id} className={"prog-day" + (d.id === nextId ? " next" : "")}>
              <div className="prog-day-head">
                <span className={"sess-ic k-" + d.kind}><Icon size={16} strokeWidth={2.1} /></span>
                <h3>{d.name}</h3>
                {d.id === nextId && <span className="tag accent">{t("next_up")}</span>}
              </div>
              {d.kind === "strength" ? (
                <ul className="plan">
                  {d.items.map((i) => (
                    <li key={i.id}>
                      {book[i.exercise_id]
                        ? <button className="plan-name link" onClick={() => setGuide({ id: i.exercise_id, name: exName(i) })}>{exName(i)}</button>
                        : <span className="plan-name">{exName(i)}</span>}
                      <span className="plan-target">
                        {i.sets} × {i.reps_min}–{i.reps_max}{i.kind === "time" ? " " + t("u_sec") : ""}
                        <i> · {restText(i.rest)}</i>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="next-note">{[d.minutes > 0 && mins(d.minutes), d.note].filter(Boolean).join(" · ") || t(`kind_${d.kind}`)}</p>
              )}
            </section>
          );
        })}
      </div>
      <div className="prog-foot">
        <span>{t("program_edit_hint")}</span>
        <button className="btn ghost" onClick={() => onAsk(t("ask_change"))}><Sparkles size={15} />{t("ask_change_btn")}</button>
      </div>
      {guide && <GuideModal id={guide.id} name={guide.name} onClose={() => setGuide(null)} />}
    </>
  );
}
