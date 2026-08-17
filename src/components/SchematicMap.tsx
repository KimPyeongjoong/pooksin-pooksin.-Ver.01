"use client";

// 스키매틱(편집된) 노선도.
// 서울교통공사 사이버스테이션 데이터(linemap.json)를 그대로 그립니다.
// 각 노선은 좌표를 이은 색선으로, 각 역은 클릭 가능한 마커로 렌더합니다.

import { useEffect, useRef, useState } from "react";
import linemap from "@/lib/linemap.json";

type Node = { x: number; y: number; m?: boolean; ind?: boolean; name?: string; cd?: string; lp?: string; mk?: string };
type Line = { key: string; label: string; indicator: string; color: string; width: number; nodes: Node[] };
const LINES = linemap as Line[];

// 노선 종점 뱃지 (노선명/번호)
const BADGES: { x: number; y: number; text: string; color: string }[] = [];
for (const l of LINES)
  for (const n of l.nodes)
    if (n.ind) BADGES.push({ x: n.x, y: n.y, text: l.indicator, color: l.color });

// 전체 좌표 범위 → viewBox 계산 (모듈 로드 시 1회)
const BOUNDS = (() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of LINES)
    for (const n of l.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
  const pad = 8;
  return { minX: minX - pad, minY: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
})();

// 각 노선의 SVG path (moveTo/indicator 처리)
const PATHS = LINES.map((l) => {
  // moveTo(선 끊김) 지점은 반드시 M으로 새 구간 시작 → 선이 가로지르지 않음
  let d = "";
  let started = false;
  for (const n of l.nodes) {
    if (n.m || !started) {
      d += `M${n.x} ${n.y}`;
      started = true;
    } else d += `L${n.x} ${n.y}`;
  }
  return d;
});

// 역 마커 목록 (이름 있는 노드)
type Marker = { name: string; x: number; y: number; color: string; interchange: boolean; lp?: string };
const MARKERS: Marker[] = [];
for (const l of LINES)
  for (const n of l.nodes)
    if (n.name && !n.ind)
      MARKERS.push({ name: n.name, x: n.x, y: n.y, color: l.color, interchange: n.mk === "interchange", lp: n.lp });

// 환승역은 여러 노선에 중복 등장 → 이름 기준으로 하나만 남기기
const interNames = new Set(MARKERS.filter((m) => m.interchange).map((m) => m.name));
// 일반역(단일 노선) 점: 환승역 이름과 겹치지 않는 것만
const DOTS = MARKERS.filter((m) => !interNames.has(m.name));
// 환승역 마커: 이름당 1개
const interMap = new Map<string, Marker>();
for (const m of MARKERS) if (m.interchange && !interMap.has(m.name)) interMap.set(m.name, m);
const INTERCHANGES = [...interMap.values()];
// 라벨: 이름당 1개 (환승역이면 환승 마커 위치 기준)
const labelMap = new Map<string, Marker>();
for (const m of DOTS) if (!labelMap.has(m.name)) labelMap.set(m.name, m);
for (const m of INTERCHANGES) labelMap.set(m.name, m);
const LABELS = [...labelMap.values()];

function labelOffset(lp?: string) {
  const g = 2.0; // 마커-라벨 간격(수직/수평)
  const dg = 1.5; // 대각선 성분(대각선이 너무 멀어지지 않게)
  switch ((lp || "S").toUpperCase()) {
    case "N": return { dx: 0, dy: -g, anchor: "middle" as const };
    case "S": return { dx: 0, dy: g + 1.5, anchor: "middle" as const };
    case "E": return { dx: g, dy: 0.7, anchor: "start" as const };
    case "W": return { dx: -g, dy: 0.7, anchor: "end" as const };
    case "NE": return { dx: dg, dy: -dg, anchor: "start" as const };
    case "NW": return { dx: -dg, dy: -dg, anchor: "end" as const };
    case "SE": return { dx: dg, dy: dg + 0.9, anchor: "start" as const };
    case "SW":
    case "WS": return { dx: -dg, dy: dg + 0.9, anchor: "end" as const };
    default: return { dx: 0, dy: g + 1.5, anchor: "middle" as const };
  }
}

type Focus = {
  dep: string;
  arr: string;
  stations: string[];
  legs: { line: string; start: string; end: string }[];
};
type Props = {
  onStationClick?: (name: string) => void;
  selected?: string | null;
  popoverOpen?: boolean;
  focus?: Focus | null;
  onStart?: () => void;
  onWaypoint?: () => void;
  onEnd?: () => void;
  onTimetable?: () => void;
  onLive?: () => void;
};

// 노선명 정규화(라벨 표기 차이 흡수: "경의·중앙선" vs "경의중앙선")
const normLine = (s: string) => (s || "").replace(/[·\s]/g, "").replace(/선$/, "");

export default function SchematicMap({
  onStationClick,
  selected,
  popoverOpen,
  focus,
  onStart,
  onWaypoint,
  onEnd,
  onTimetable,
  onLive,
}: Props) {
  const routeStationSet = focus ? new Set(focus.stations) : null;
  // 출발~도착 사이 "구간"만 뽑아 실제 노선 마디를 따라 그림
  const routeSegments = focus
    ? focus.legs
        .map((leg) => {
          const line = LINES.find((l) => normLine(l.label) === normLine(leg.line));
          if (!line) return null;
          const idxs = line.nodes
            .map((n, i) => (n.name === leg.start || n.name === leg.end ? i : -1))
            .filter((i) => i >= 0);
          if (idxs.length < 2) return null;
          const a = Math.min(...idxs);
          const b = Math.max(...idxs);
          let d = "";
          line.nodes.slice(a, b + 1).forEach((n, i) => {
            d += (i === 0 ? "M" : "L") + n.x + " " + n.y;
          });
          return { d, color: line.color };
        })
        .filter((x): x is { d: string; color: string } => x !== null)
    : [];
  // viewBox 기반 확대/이동 (CSS scale이 아니라 벡터 자체를 다시 그림 → 항상 선명)
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, lastX: 0, lastY: 0, moved: false });
  const cfg = useRef({ fitW: BOUNDS.w }); // 컨테이너에 딱 맞는 viewBox 폭

  const MAX_OUT = 1.85; // 최대 줌아웃(=처음 화면). 이보다 작게(멀리) 안 나감
  const MAX_IN = 16; // 최대 줌인

  const [view, setView] = useState({ x: BOUNDS.minX, y: BOUNDS.minY, w: BOUNDS.w, h: BOUNDS.h });

  // 처음 열 때: 컨테이너 비율에 맞춰 viewBox 잡고, 최대 줌아웃(1.85배) 상태로 중앙 정렬
  useEffect(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ca = rect.width / rect.height;
    const fitW = Math.max(BOUNDS.w, BOUNDS.h * ca);
    cfg.current.fitW = fitW;
    const w = fitW / MAX_OUT;
    const h = w / ca;
    const cx = BOUNDS.minX + BOUNDS.w / 2;
    const cy = BOUNDS.minY + BOUNDS.h / 2;
    setView({ x: cx - w / 2, y: cy - h / 2, w, h });
  }, []);

  const clampW = (w: number) =>
    Math.min(cfg.current.fitW / MAX_OUT, Math.max(cfg.current.fitW / MAX_IN, w));

  // 역이 선택되면 그 역을 화면 위쪽(하단 시트에 안 가리는 영역)으로 이동
  useEffect(() => {
    if (!selected || focus) return;
    const m = MARKERS.find((x) => x.name === selected);
    if (!m) return;
    setView((v) => ({ ...v, x: m.x - v.w / 2, y: m.y - v.h * 0.4 }));
  }, [selected, focus]);

  // 출발·도착이 정해지면 그 경로 영역으로 줌인
  useEffect(() => {
    if (!focus) return;
    const dm = MARKERS.find((x) => x.name === focus.dep);
    const am = MARKERS.find((x) => x.name === focus.arr);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!dm || !am || !rect || rect.width === 0) return;
    const ca = rect.width / rect.height;
    const pad = 16;
    let minX = Math.min(dm.x, am.x) - pad;
    let minY = Math.min(dm.y, am.y) - pad;
    let w = Math.abs(dm.x - am.x) + pad * 2;
    let h = Math.abs(dm.y - am.y) + pad * 2;
    const minW = cfg.current.fitW / 6; // 너무 확대되지 않게
    if (w < minW) { minX -= (minW - w) / 2; w = minW; }
    if (w / h > ca) { const nh = w / ca; minY -= (nh - h) / 2; h = nh; }
    else { const nw = h * ca; minX -= (nw - w) / 2; w = nw; }
    minY -= h * 0.12; // 하단 시트 가림 방지 (경로를 살짝 위로)
    setView({ x: minX, y: minY, w, h });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.dep, focus?.arr]);

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { active: true, lastX: e.clientX, lastY: e.clientY, moved: false };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current.active) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = e.clientX - drag.current.lastX;
    const dy = e.clientY - drag.current.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    drag.current.lastX = e.clientX;
    drag.current.lastY = e.clientY;
    setView((v) => ({ ...v, x: v.x - dx * (v.w / rect.width), y: v.y - dy * (v.h / rect.height) }));
  }
  function onPointerUp() {
    drag.current.active = false;
  }
  function zoomAt(sx: number, sy: number, factor: number, rect: DOMRect) {
    setView((v) => {
      const newW = clampW(v.w * factor);
      const newH = newW * (v.h / v.w); // 비율 유지
      const px = v.x + (sx / rect.width) * v.w; // 커서 아래 좌표
      const py = v.y + (sy / rect.height) * v.h;
      return { x: px - (sx / rect.width) * newW, y: py - (sy / rect.height) * newH, w: newW, h: newH };
    });
  }
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 스크롤 업 = 줌인 = viewBox 작게(factor<1)
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 0.87 : 1.15, rect);
  }
  function zoomButton(factor: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.width / 2, rect.height / 2, factor, rect);
  }
  function clickStation(name: string) {
    if (drag.current.moved) return;
    onStationClick?.(name);
  }

  const showLabels = true; // 최대 줌아웃부터 항상 역명 노출
  const stationR = 0.65;
  const interR = 1.0;

  // 선택한 역의 화면상 위치(팝오버 앵커)
  const anchor = (() => {
    if (!popoverOpen || !selected) return null;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const m = MARKERS.find((x) => x.name === selected) || labelMap.get(selected);
    if (!m) return null;
    const scale = rect.width / view.w; // viewBox 비율=컨테이너 비율
    return { left: (m.x - view.x) * scale, top: (m.y - view.y) * scale };
  })();

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
        <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet">
          {/* 노선 색선 (포커스 시 전체 흐리게) */}
          {LINES.map((l, i) => (
            <path
              key={l.key}
              d={PATHS[i]}
              fill="none"
              stroke={l.color}
              strokeWidth={l.width * 0.32}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={focus ? 0.14 : 1}
            />
          ))}

          {/* 경로 구간 강조 (출발~도착 사이만 진하게) */}
          {routeSegments.map((s, i) => (
            <path
              key={`rs-${i}`}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth={0.95}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          <g>

          {/* 일반역 점 */}
          {DOTS.map((m, i) => (
            <circle
              key={`d${i}`}
              cx={m.x}
              cy={m.y}
              r={stationR}
              fill="var(--surface)"
              stroke={m.color}
              strokeWidth={0.4}
              className="rm-dot"
              opacity={focus ? (routeStationSet!.has(m.name) ? 1 : 0.22) : 1}
              onClick={() => clickStation(m.name)}
            />
          ))}

          {/* 환승역 마커 (이름당 1개) */}
          {INTERCHANGES.map((m, i) => (
            <circle
              key={`x${i}`}
              cx={m.x}
              cy={m.y}
              r={interR}
              fill="var(--surface)"
              stroke="var(--ink)"
              strokeWidth={0.4}
              className="rm-dot"
              opacity={focus ? (routeStationSet!.has(m.name) ? 1 : 0.22) : 1}
              onClick={() => clickStation(m.name)}
            />
          ))}

          {/* 종점 노선명 뱃지 */}
          {BADGES.map((b, i) => {
            const w = Math.max(2.6, b.text.length * 1.35 + 1.4);
            const h = 2.7;
            return (
              <g key={`b${i}`} style={{ pointerEvents: "none" }} opacity={focus ? 0.18 : 1}>
                <rect x={b.x - w / 2} y={b.y - h / 2} width={w} height={h} rx={0.7} fill={b.color} />
                <text
                  x={b.x}
                  y={b.y}
                  fontSize={1.9}
                  fill="#fff"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontWeight={700}
                >
                  {b.text}
                </text>
              </g>
            );
          })}

          {/* 역 이름 (항상 노출 · 포커스 시 경로 위 역만 진하게) */}
          {showLabels &&
            LABELS.map((m, i) => {
              const o = labelOffset(m.lp);
              const onRoute = !focus || routeStationSet!.has(m.name);
              return (
                <text
                  key={`l-${i}`}
                  className="rm-label"
                  x={m.x + o.dx}
                  y={m.y + o.dy}
                  fontSize={focus && onRoute ? 2.3 : 1.9}
                  fontWeight={focus && onRoute ? 800 : 600}
                  textAnchor={o.anchor}
                  opacity={focus ? (onRoute ? 1 : 0.28) : 1}
                  onClick={() => clickStation(m.name)}
                  style={{ cursor: "pointer" }}
                >
                  {m.name}
                </text>
              );
            })}

          {/* 선택된 역 강조 (링만 — 이름 중복 방지) */}
          {!focus && selected &&
            MARKERS.filter((m) => m.name === selected).slice(0, 1).map((m, i) => (
              <circle
                key={`sel-${i}`}
                cx={m.x}
                cy={m.y}
                r={interR + 1.2}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={0.9}
              />
            ))}
          </g>

          {/* 출발/도착 핀 (포커스 시) */}
          {focus &&
            ([
              [focus.dep, "var(--dep)", "출"],
              [focus.arr, "var(--arr)", "도"],
            ] as const).map(([name, color, ch]) => {
              const m = MARKERS.find((x) => x.name === name);
              if (!m) return null;
              return (
                <g key={ch}>
                  <circle cx={m.x} cy={m.y} r={2.6} fill={color} stroke="#fff" strokeWidth={0.8} />
                  <text x={m.x} y={m.y} fontSize={2.4} fill="#fff" textAnchor="middle" dominantBaseline="central" fontWeight={800}>
                    {ch}
                  </text>
                </g>
              );
            })}
        </svg>

      {/* 역 클릭 팝오버 (출발/경유/도착 + 전체 시간표) */}
      {anchor && (
        <div className="popover" style={{ left: anchor.left, top: anchor.top }}>
          <div className="popover-row">
            <button className="pop-btn" onClick={onStart}>
              <span className="pop-ic dep" />
              출발
            </button>
            <button className="pop-btn" onClick={onWaypoint}>
              <span className="pop-ic way" />
              경유
            </button>
            <button className="pop-btn" onClick={onEnd}>
              <span className="pop-ic arr" />
              도착
            </button>
          </div>
          <div className="pop-div" />
          <div className="popover-row2">
            <button className="pop-full" onClick={onLive}>
              실시간
            </button>
            <button className="pop-full" onClick={onTimetable}>
              전체 시간표
            </button>
          </div>
        </div>
      )}

      <div className="map-legend">
        <b>수도권 노선도</b> · 역을 눌러 실시간 도착
      </div>
      <div className="map-zoom">
        <button className="mz-btn" onClick={() => zoomButton(0.72)} aria-label="확대">+</button>
        <button className="mz-btn" onClick={() => zoomButton(1.4)} aria-label="축소">−</button>
      </div>
    </div>
  );
}
