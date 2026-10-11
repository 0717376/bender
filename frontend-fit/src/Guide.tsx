import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Info, X } from "lucide-react";
import { frame, GUIDE_KEYS, guideText, refreshGuides, useBook } from "./guides";
import { t } from "./i18n";

/** Вход в карточку техники из тренировки: кадр упражнения, а без него — значок. */
export function GuideThumb({ id, onOpen }: { id: number; onOpen: () => void }) {
  const info = useBook()[id];
  const [broken, setBroken] = useState(false);
  if (!info) return null;
  if (info.image && !broken) {
    return (
      <button className="ex-thumb" onClick={onOpen} aria-label={t("guide_open")}>
        <img src={frame(info.image, 0)} alt="" onError={() => setBroken(true)} />
      </button>
    );
  }
  return <button className="icon-btn" onClick={onOpen} aria-label={t("guide_open")}><Info size={20} /></button>;
}

/** Как выглядит упражнение и на что смотреть: два кадра сменяют друг друга, под ними четыре строки. */
export default function GuideModal({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const info = useBook()[id];
  const [n, setN] = useState<0 | 1>(0);
  const [broken, setBroken] = useState(false);
  const pic = !!info?.image && !broken;
  useEffect(() => { void refreshGuides(); }, []);
  useEffect(() => {
    if (!pic) return;
    const timer = setInterval(() => setN((x) => (x ? 0 : 1)), 1400);
    return () => clearInterval(timer);
  }, [pic]);
  const text = info ? guideText(info) : {};
  const rows = GUIDE_KEYS.filter((k) => text[k]);
  // В корень страницы: открытая карточка упражнения анимируется, и окно внутри неё
  // позиционировалось бы от карточки, а не от экрана.
  return createPortal(
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{name}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>
        {pic && (
          <div className="guide-pic">
            {([0, 1] as const).map((k) => (
              <img key={k} className={n === k ? "on" : ""} src={frame(info.image, k)} alt="" onError={() => setBroken(true)} />
            ))}
            <span className="guide-dots"><i className={n === 0 ? "on" : ""} /><i className={n === 1 ? "on" : ""} /></span>
          </div>
        )}
        {rows.map((k) => (
          <div key={k} className="guide-row">
            <div className="stm-label">{t(`guide_${k}`)}</div>
            <p>{text[k]}</p>
          </div>
        ))}
        {!pic && rows.length === 0 && <div className="empty">{t("guide_empty")}</div>}
      </div>
    </div>,
    document.body,
  );
}
