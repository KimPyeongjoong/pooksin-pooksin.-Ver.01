// 노선도 데이터(linemap.json)를 이용해 특정 역의 노선/앞역/뒷역을 찾습니다.
// (도착정보 시트의 "‹ 이전역 · 현재역 · 다음역 ›" 스텝퍼용)

import linemap from "./linemap.json";
import { lineColor } from "./line-colors";

type Node = { x: number; y: number; name?: string };
type Line = { key: string; label: string; indicator: string; color: string; nodes: Node[] };
const LINES = linemap as Line[];

export type Neighbors = {
  line: string;
  indicator: string;
  color: string;
  prev: string | null;
  next: string | null;
};

// 노선 이름 표기 차이를 흡수합니다 ("경의·중앙선" = "경의중앙선", "서해" = "서해선")
const norm = (s: string) => (s || "").replace(/[·\s]/g, "").replace(/선$/, "");

// 노선 위 역들을 순서대로 (실시간 열차 위치 화면에서 일직선으로 그릴 때 씁니다)
export function lineStations(lineName: string): string[] {
  const want = norm(lineName);
  const l =
    LINES.find((x) => norm(x.label) === want) ??
    LINES.find((x) => norm(x.label).includes(want) || want.includes(norm(x.label)));
  if (!l) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of l.nodes) {
    if (!n.name || seen.has(n.name)) continue;
    seen.add(n.name);
    out.push(n.name);
  }
  return out;
}

// 그 역이 지나는 모든 노선 이름
export function linesAtStation(name: string): { label: string; color: string; indicator: string }[] {
  return LINES.filter((l) => l.nodes.some((n) => n.name === name)).map((l) => ({
    label: l.label,
    color: lineColor(l.label),
    indicator: l.indicator,
  }));
}

// 해당 역이 처음 등장하는 노선 기준으로 앞/뒤 역을 반환
export function stationNeighbors(name: string): Neighbors | null {
  for (const l of LINES) {
    const named = l.nodes.filter((n) => n.name);
    const idx = named.findIndex((n) => n.name === name);
    if (idx >= 0) {
      return {
        line: l.label,
        indicator: l.indicator,
        color: lineColor(l.label),
        prev: named[idx - 1]?.name ?? null,
        next: named[idx + 1]?.name ?? null,
      };
    }
  }
  return null;
}

// 노선도에 있는 모든 노선 (탑승 노선 고르기용)
export const ALL_LINES: { label: string; indicator: string }[] = LINES.map((l) => ({
  label: l.label,
  indicator: l.indicator,
}));
