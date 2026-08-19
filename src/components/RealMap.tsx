"use client";

// 실제 위치 기반 지하철 지도.
// ODsay에서 받은 역 좌표(station-coords.json)를 화면 좌표로 변환해
// 각 역을 실제 위치에 점으로 찍고, 확대/이동/클릭을 지원합니다.

import { useMemo, useRef, useState } from "react";
import coordsRaw from "@/lib/station-coords.json";
import { lineColor } from "@/lib/line-colors";
import { STATION_GROUPS } from "@/lib/stations";

const coords = coordsRaw as Record<string, { x: number; y: number }>;

// 노선 색상은 src/lib/line-colors.ts 한 곳에서만 관리합니다.


// ── 좌표 → 화면좌표 변환 (모듈 로드 시 1회 계산) ──
type Pt = { name: string; sx: number; sy: number; color: string };
const PROJECTION = (() => {
  const items = STATION_GROUPS.filter((g) => coords[g.name]).map((g) => ({
    name: g.name,
    lng: coords[g.name].x,
    lat: coords[g.name].y,
    color: lineColor(g.lines[0]),
  }));
  const lngs = items.map((i) => i.lng);
  const lats = items.map((i) => i.lat);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const meanLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  const W = 1000;
  const pad = 24;
  const scale = (W - pad * 2) / ((maxLng - minLng) * cosLat);
  const H = (maxLat - minLat) * scale + pad * 2;
  const points: Pt[] = items.map((i) => ({
    name: i.name,
    sx: pad + (i.lng - minLng) * cosLat * scale,
    sy: pad + (maxLat - i.lat) * scale,
    color: i.color,
  }));
  const byName = new Map(points.map((p) => [p.name, p]));
  return { points, W, H, byName };
})();

type Props = {
  onStationClick?: (name: string) => void;
  selected?: string | null;
  trains?: { name: string; line: string }[];
};

export default function RealMap({ onStationClick, selected, trains }: Props) {
  const { points, W, H, byName } = PROJECTION;
  const [view, setView] = useState({ tx: 0, ty: 0, k: 1 });
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, lastX: 0, lastY: 0, moved: false });

  function clampK(k: number) {
    return Math.min(9, Math.max(0.6, k));
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { active: true, lastX: e.clientX, lastY: e.clientY, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.lastX;
    const dy = e.clientY - drag.current.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    drag.current.lastX = e.clientX;
    drag.current.lastY = e.clientY;
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
  }
  function onPointerUp() {
    drag.current.active = false;
  }

  function zoomAt(cx: number, cy: number, factor: number) {
    setView((v) => {
      const k = clampK(v.k * factor);
      const ratio = k / v.k;
      return { k, tx: cx - (cx - v.tx) * ratio, ty: cy - (cy - v.ty) * ratio };
    });
  }
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 0.87);
  }
  function zoomButton(factor: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  function clickStation(name: string) {
    if (drag.current.moved) return; // 드래그였으면 무시
    onStationClick?.(name);
  }

  const sel = selected ? byName.get(selected) : null;
  const dotR = 2.6 / view.k;

  const trainPts = useMemo(
    () =>
      (trains ?? [])
        .map((t) => ({ ...t, pt: byName.get(t.name) }))
        .filter((t) => t.pt),
    [trains, byName]
  );

  return (
    <div
      className="realmap"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
    >
      <div
        className="realmap-inner"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})` }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
          {/* 역 점 */}
          {points.map((p) => (
            <circle
              key={p.name}
              className="rm-dot"
              cx={p.sx}
              cy={p.sy}
              r={dotR}
              fill={p.color}
              stroke="var(--surface)"
              strokeWidth={0.6 / view.k}
              onClick={() => clickStation(p.name)}
            />
          ))}

          {/* 실시간 열차 위치 */}
          {trainPts.map((t, i) => (
            <circle
              key={`tr-${i}`}
              className="rm-train"
              cx={t.pt!.sx}
              cy={t.pt!.sy}
              r={3.4 / view.k}
              fill={lineColor(t.line)}
              stroke="#fff"
              strokeWidth={1.4 / view.k}
            />
          ))}

          {/* 선택된 역 강조 + 라벨 */}
          {sel && (
            <>
              <circle
                cx={sel.sx}
                cy={sel.sy}
                r={6 / view.k}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2 / view.k}
              />
              <text
                className="rm-label"
                x={sel.sx}
                y={sel.sy - 9 / view.k}
                fontSize={13 / view.k}
                textAnchor="middle"
              >
                {sel.name}
              </text>
            </>
          )}
        </svg>
      </div>

      <div className="map-legend">
        <b>실제 위치 지도</b> · 역을 눌러 실시간 도착 확인
      </div>
      <div className="map-zoom">
        <button className="mz-btn" onClick={() => zoomButton(1.4)} aria-label="확대">
          +
        </button>
        <button className="mz-btn" onClick={() => zoomButton(0.72)} aria-label="축소">
          −
        </button>
      </div>
    </div>
  );
}
