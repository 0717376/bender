import { useEffect } from "react";
import { t } from "./i18n";

export default function ConfirmModal({ question, detail, onConfirm, onClose }: {
  question: string;
  detail?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="confirm-q">{question}</div>
        {detail && <div className="confirm-detail">{detail}</div>}
        <div className="confirm-btns">
          <button className="qbtn" onClick={onClose}>{t("cancel")}</button>
          <button className="qbtn confirm-del" autoFocus onClick={onConfirm}>{t("delete")}</button>
        </div>
      </div>
    </div>
  );
}
