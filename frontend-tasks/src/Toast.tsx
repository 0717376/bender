import { useEffect } from "react";
import { t as tr } from "./i18n"; // alias: `t` names toasts in map callbacks here
import type { ToastMsg } from "./useTasks";

const LIFETIME_MS = 5000;

export default function Toasts({ toasts, dismiss }: { toasts: ToastMsg[]; dismiss: (id: string) => void }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>
  );
}

function Toast({ toast, dismiss }: { toast: ToastMsg; dismiss: (id: string) => void }) {
  useEffect(() => {
    const h = setTimeout(() => dismiss(toast.id), LIFETIME_MS);
    return () => clearTimeout(h);
  }, [toast.id, dismiss]);

  return (
    <div className="toast">
      <span className="toast-text">{toast.text}</span>
      {toast.undo && (
        <button
          className="toast-undo"
          onClick={() => { toast.undo!(); dismiss(toast.id); }}
        >
          {tr("undo")}
        </button>
      )}
    </div>
  );
}
