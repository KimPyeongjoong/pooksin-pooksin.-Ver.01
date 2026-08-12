// 수도권 전체 역 데이터 (stations.json에서 불러옴)
// stations.json은 서울열린데이터광장 '노선별 지하철역 정보'에서 받아 내장한 것입니다.
// (799행 = 환승역이 노선마다 중복 → 이름 기준으로 묶어 사용)

import raw from "./stations.json";

export type StationRow = { name: string; line: string; code: string };
const all = raw as StationRow[];

// "01호선" → "1호선", "02호선" → "2호선" 처럼 노선명 정리
export function prettyLine(line: string): string {
  const m = line.match(/^0?(\d+)호선$/);
  if (m) return `${m[1]}호선`;
  return line;
}

export type StationGroup = { name: string; lines: string[] };

// 이름 기준으로 묶기 (환승역은 여러 노선을 가짐)
const byName = new Map<string, Set<string>>();
for (const s of all) {
  if (!byName.has(s.name)) byName.set(s.name, new Set());
  byName.get(s.name)!.add(prettyLine(s.line));
}

export const STATION_GROUPS: StationGroup[] = [...byName.entries()]
  .map(([name, lines]) => ({ name, lines: [...lines] }))
  .sort((a, b) => a.name.localeCompare(b.name, "ko"));

export const STATION_COUNT = STATION_GROUPS.length;

// 역 이름 검색 (부분 일치)
export function searchStations(query: string, limit = 40): StationGroup[] {
  const q = query.trim();
  if (!q) return [];
  const starts: StationGroup[] = [];
  const contains: StationGroup[] = [];
  for (const s of STATION_GROUPS) {
    if (s.name.startsWith(q)) starts.push(s);
    else if (s.name.includes(q)) contains.push(s);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
