// 노선도 데이터(linemap.json)를 이용해 특정 역의 노선/앞역/뒷역을 찾습니다.
// (도착정보 시트의 "‹ 이전역 · 현재역 · 다음역 ›" 스텝퍼용)

import linemap from "./linemap.json";

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

// 해당 역이 처음 등장하는 노선 기준으로 앞/뒤 역을 반환
export function stationNeighbors(name: string): Neighbors | null {
  for (const l of LINES) {
    const named = l.nodes.filter((n) => n.name);
    const idx = named.findIndex((n) => n.name === name);
    if (idx >= 0) {
      return {
        line: l.label,
        indicator: l.indicator,
        color: l.color,
        prev: named[idx - 1]?.name ?? null,
        next: named[idx + 1]?.name ?? null,
      };
    }
  }
  return null;
}
