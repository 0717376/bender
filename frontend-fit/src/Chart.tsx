import { num } from "./fmt";
import { shortDate } from "./i18n";

export interface Point { day: string; y: number }

const W = 600, PAD = { l: 8, r: 58, t: 16, b: 28 };

const dayNum = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

/** Где рисовать точки: по оси x — дни (а не номера точек: пропуск в две недели должен быть виден). */
export function layout(points: Point[], height: number) {
  const xs = points.map((p) => dayNum(p.day));
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  // Ровная линия не должна лежать на нижней кромке, а шум в полкило — выглядеть обвалом.
  const span = Math.max(y1 - y0, Math.abs(y1) * 0.04, 1e-6);
  const mid = (y0 + y1) / 2;
  y0 = mid - span * 0.62;
  y1 = mid + span * 0.62;
  const iw = W - PAD.l - PAD.r, ih = height - PAD.t - PAD.b;
  const px = (x: number) => PAD.l + (x1 === x0 ? iw / 2 : ((x - x0) / (x1 - x0)) * iw);
  const py = (y: number) => PAD.t + (1 - (y - y0) / (y1 - y0)) * ih;
  return { pts: points.map((p, i) => ({ x: px(xs[i]), y: py(p.y), p })), py, min: Math.min(...ys), max: Math.max(...ys) };
}

/** Линия по дням. marks — дни, которые отметить засечками под графиком (тренировки). */
export default function LineChart({ points, height = 170, digits = 1, marks, color = "var(--accent)", id }: {
  points: Point[]; height?: number; digits?: number; marks?: string[]; color?: string; id: string;
}) {
  if (points.length === 0) return null;
  const { pts, py, min, max } = layout(points, height);
  const line = pts.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
  const base = height - PAD.b;
  const last = pts[pts.length - 1];
  const x0 = dayNum(points[0].day), x1 = dayNum(points[points.length - 1].day);
  const mx = (iso: string) => PAD.l + (x1 === x0 ? 0 : ((dayNum(iso) - x0) / (x1 - x0)) * (W - PAD.l - PAD.r));
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {max !== min && [max, min].map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={py(v)} y2={py(v)} className="chart-grid" />
          <text x={W - PAD.r + 6} y={py(v) + 4} className="chart-tick">{num(v, digits)}</text>
        </g>
      ))}
      {pts.length > 1 && <path d={`${line} L${last.x.toFixed(1)},${base} L${pts[0].x.toFixed(1)},${base} Z`} fill={`url(#${id})`} />}
      {pts.length > 1 && <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />}
      {pts.length <= 40 && pts.map((q) => <circle key={q.p.day} cx={q.x} cy={q.y} r="2.6" fill={color} />)}
      <circle cx={last.x} cy={last.y} r="4.6" fill={color} stroke="var(--panel)" strokeWidth="2" />
      {max === min && <text x={W - PAD.r + 6} y={last.y + 4} className="chart-tick">{num(last.p.y, digits)}</text>}
      {marks?.filter((d) => dayNum(d) >= x0 && dayNum(d) <= x1).map((d) => (
        <rect key={d} x={mx(d) - 1.5} y={base + 3} width="3" height="6" rx="1.5" className="chart-mark" />
      ))}
      <text x={PAD.l} y={height - 4} className="chart-tick">{shortDate(points[0].day)}</text>
      {points.length > 1 && (
        <text x={W - PAD.r} y={height - 4} textAnchor="end" className="chart-tick">{shortDate(points[points.length - 1].day)}</text>
      )}
    </svg>
  );
}
