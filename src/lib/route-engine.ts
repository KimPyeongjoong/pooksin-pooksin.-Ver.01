// 경로 탐색 — 우리가 직접 계산합니다 (외부 API 호출 0건)
//
// 왜 만들었나:
//   경로검색만 ODsay에 남아 있었는데, 무료 한도가 하루 1,000건이라 조금만 써도 멈춥니다.
//   재료는 이미 다 앱 안에 있습니다.
//     ① 노선도(linemap.json)      — 어느 역이 어느 역과 이어지는지
//     ② 구간 소요시간(section-times.json) — 역과 역 사이 실제 몇 초 (공공 시간표에서 뽑음)
//     ③ 역 좌표(station-coords.json)     — 거리·요금 계산
//   이 셋으로 최단시간 경로를 직접 구합니다.
//
//     ④ 환승 정보(transfers.json)        — 환승 소요시간 + 몇 호차 몇 번 문
//
// 못 하는 것 (정직하게):
//   - **요금**: 지금은 거리비례 공식으로 계산합니다.
//     서울교통공사 실시간운임정보(data.go.kr 15143846)를 붙이면 정확해집니다.
//   - 급행/특급을 따로 계산하지 않습니다. 늘 완행 기준입니다.

import linemap from "./linemap.json";
import coordsJson from "./station-coords.json";
import sectionJson from "./section-times.json";
import transferJson from "./transfers.json";
import extraJson from "./transfers-extra.json";
import { lineColor, shortLine } from "./line-colors";

type Node = { x: number; y: number; m?: boolean; name?: string };
type Line = { key: string; label: string; nodes: Node[] };
const LINES = linemap as Line[];
const COORDS = coordsJson as Record<string, { x: number; y: number }>;
const SECTIONS = (sectionJson as { lines: Record<string, Record<string, number>> }).lines;

// 환승 정보 (서울교통공사 "서울 도시철도 환승정보" 자료).
// 역·노선쌍마다 **실제 걸리는 시간**과 **몇 호차 몇 번 문**으로 내려/타야 하는지가 들어 있습니다.
// 예전에는 이 둘을 ODsay만 준다고 보고 3분 상수를 썼는데, 실제로는 1분~22분까지 차이가 납니다.
export type TransferCase = { fromWay: string; toWay: string; off: string; on: string; sec: number };
const TRANSFERS = (
  transferJson as { stations: Record<string, Record<string, Record<string, TransferCase[]>>> }
).stations;

export function transferCases(station: string, from: string, to: string): TransferCase[] {
  return TRANSFERS[norm(station)]?.[shortLine(from)]?.[shortLine(to)] ?? [];
}

// 서울교통공사 자료가 없는 환승(코레일·GTX·민자 노선)을 ODsay로 재서 채워둔 것.
// scripts/build-transfers-odsay.mjs 참고. 값은 초.
const EXTRA = (extraJson as { stations: Record<string, Record<string, Record<string, number>>> })
  .stations;

// 그 역에서 A노선 → B노선 환승에 걸리는 시간(초).
// ① 서울교통공사 공식 자료 → ② ODsay로 보충한 값 → ③ 그래도 없으면 상수
function transferSecOf(station: string, from: string, to: string): number {
  const cases = transferCases(station, from, to);
  if (cases.length) {
    const v = cases.map((c) => c.sec).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)]; // 방향마다 조금씩 달라 중앙값
  }
  const extra = EXTRA[norm(station)]?.[shortLine(from)]?.[shortLine(to)];
  return extra ?? TRANSFER_SEC;
}

// 역 이름 표기 차이 흡수 (src/lib/timetable.ts 와 같은 규칙)
const NAME_ALIAS: Record<string, string> = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s: string) =>
  (s || "")
    .replace(/\s/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/역$/, "")
    .trim();
export const norm = (s: string) => NAME_ALIAS[bare(s)] ?? bare(s);

// ── 조정 가능한 값 ───────────────────────────────────────────
const TRANSFER_SEC = 180; // 환승 1회에 잡는 시간 (공공 데이터 없음 → 임시 상수)
const DEFAULT_SPEED_KMH = 32; // 구간 소요시간이 없을 때 거리로 추정할 때 쓰는 표정속도
const BOARD_WAIT_SEC = 0; // 승차 대기는 시간표 화면에서 따로 다룹니다

// ── 노선 그래프 ─────────────────────────────────────────────
type Edge = { to: string; line: string; sec: number };
// 역(정규화 이름) → 그 역에서 갈 수 있는 이웃들
const GRAPH = new Map<string, Edge[]>();
// 역이 지나는 노선들
const LINES_AT = new Map<string, Set<string>>();
// 정규화 이름 → 화면에 쓸 원래 이름
const DISPLAY = new Map<string, string>();

function km(a: { x: number; y: number }, b: { x: number; y: number }) {
  const R = 6371;
  const dLat = ((b.y - a.y) * Math.PI) / 180;
  const dLon = ((b.x - a.x) * Math.PI) / 180;
  const la1 = (a.y * Math.PI) / 180;
  const la2 = (b.y * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 두 이웃 역 사이 실제 소요시간(초).
// 공공 시간표에서 뽑은 값을 쓰고, 없으면 반대 방향 값, 그것도 없으면 거리로 추정합니다.
function sectionSec(line: string, a: string, b: string): number {
  const t = SECTIONS[shortLine(line)];
  const hit = t?.[`${a}|${b}`] ?? t?.[`${b}|${a}`];
  if (hit) return hit;
  const ca = COORDS[DISPLAY.get(a) ?? a];
  const cb = COORDS[DISPLAY.get(b) ?? b];
  const d = ca && cb ? km(ca, cb) : 1.1; // 좌표도 없으면 수도권 평균 역간거리
  return Math.max(60, Math.round((d / DEFAULT_SPEED_KMH) * 3600));
}

(function buildGraph() {
  for (const l of LINES) {
    const line = l.label;

    // ⚠️ 순환선(2호선)은 한 바퀴를 돌아 첫 역 자리로 되돌아오면서 끝나는데,
    //    그 마지막 노드에는 **이름이 없습니다**. 이름만 보고 이으면 대림↔신도림 한 구간이
    //    빠져서 순환선이 끊긴 채로 그래프가 만들어집니다.
    //    (그러면 홍대입구→강남 같은 경로가 반대로 크게 돌아 환승 2번짜리로 나옵니다.)
    //    그래서 같은 좌표에 있는 이름 없는 노드를 그 역으로 봅니다.
    const nameAt = new Map<string, string>();
    for (const n of l.nodes) if (n.name) nameAt.set(`${n.x},${n.y}`, n.name);

    let prev: string | null = null;
    for (const n of l.nodes) {
      if (n.m) prev = null; // 선이 끊기는 지점에서는 이어지지 않습니다
      const name = n.name ?? nameAt.get(`${n.x},${n.y}`);
      if (!name) continue;
      const cur = norm(name);
      // ⚠️ 노선도의 역 이름에는 줄바꿈이 들어 있습니다("동대문역사\n문화공원").
      //    지도에서 두 줄로 그리려고 넣은 것이라, 경로 결과에는 그대로 쓰면 안 됩니다.
      if (!DISPLAY.has(cur)) DISPLAY.set(cur, name.replace(/\s+/g, ""));
      if (!LINES_AT.has(cur)) LINES_AT.set(cur, new Set());
      LINES_AT.get(cur)!.add(line);
      if (prev && prev !== cur) {
        const sec = sectionSec(line, prev, cur);
        if (!GRAPH.has(prev)) GRAPH.set(prev, []);
        if (!GRAPH.has(cur)) GRAPH.set(cur, []);
        GRAPH.get(prev)!.push({ to: cur, line, sec });
        GRAPH.get(cur)!.push({ to: prev, line, sec });
      }
      prev = cur;
    }
  }
})();

export function knownStation(name: string): boolean {
  return LINES_AT.has(norm(name));
}

// ── 요금 (수도권 거리비례) ───────────────────────────────────
// ⚠️ 임시 계산입니다. 15143846(실시간운임정보)을 붙이면 이 함수를 갈아끼우세요.
const BASE_FARE = 1550; // 10km까지
function fareFor(distanceKm: number): number {
  let fare = BASE_FARE;
  if (distanceKm > 10) {
    const mid = Math.min(distanceKm, 50) - 10; // 10~50km 는 5km마다 100원
    fare += Math.ceil(mid / 5) * 100;
  }
  if (distanceKm > 50) fare += Math.ceil((distanceKm - 50) / 8) * 100; // 50km 초과는 8km마다
  return fare;
}

// ── 최단시간 경로 (다익스트라) ───────────────────────────────
//
// 상태를 "역"이 아니라 "역 + 지금 타고 있는 노선"으로 둡니다.
// 그래야 환승할 때만 환승 시간을 더할 수 있습니다.
type State = { station: string; line: string };
const keyOf = (s: State) => `${s.station}|${s.line}`;

type Step = { station: string; line: string; sec: number };

function shortestPath(from: string, to: string, transferSec = TRANSFER_SEC): Step[] | null {
  const start = norm(from);
  const goal = norm(to);
  if (!LINES_AT.has(start) || !LINES_AT.has(goal)) return null;

  const dist = new Map<string, number>();
  const prev = new Map<string, { key: string; station: string; line: string }>();
  // 간단한 우선순위 큐 (역이 655개뿐이라 정렬 배열로 충분합니다)
  const pq: { key: string; d: number }[] = [];
  const push = (key: string, d: number) => {
    pq.push({ key, d });
    let i = pq.length - 1;
    while (i > 0 && pq[i - 1].d > pq[i].d) {
      [pq[i - 1], pq[i]] = [pq[i], pq[i - 1]];
      i--;
    }
  };

  for (const line of LINES_AT.get(start)!) {
    const k = keyOf({ station: start, line });
    dist.set(k, BOARD_WAIT_SEC);
    push(k, BOARD_WAIT_SEC);
  }

  let goalKey: string | null = null;
  while (pq.length) {
    const { key, d } = pq.shift()!;
    if (d > (dist.get(key) ?? Infinity)) continue;
    const [station, line] = [key.slice(0, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
    if (station === goal) {
      goalKey = key;
      break;
    }
    // ① 같은 노선으로 한 정거장 이동
    for (const e of GRAPH.get(station) ?? []) {
      if (e.line !== line) continue;
      const nk = keyOf({ station: e.to, line });
      const nd = d + e.sec;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { key, station, line });
        push(nk, nd);
      }
    }
    // ② 같은 역에서 다른 노선으로 환승
    for (const other of LINES_AT.get(station) ?? []) {
      if (other === line) continue;
      const nk = keyOf({ station, line: other });
      // 역마다 실제 환승 시간이 다릅니다(1분~22분). 자료에 있으면 그 값을 씁니다.
      const nd = d + (transferSec === TRANSFER_SEC ? transferSecOf(station, line, other) : transferSec);
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { key, station, line });
        push(nk, nd);
      }
    }
  }

  if (!goalKey) return null;

  const steps: Step[] = [];
  let cur: string | undefined = goalKey;
  while (cur) {
    const station = cur.slice(0, cur.lastIndexOf("|"));
    const line = cur.slice(cur.lastIndexOf("|") + 1);
    steps.push({ station, line, sec: dist.get(cur) ?? 0 });
    cur = prev.get(cur)?.key;
  }
  steps.reverse();
  return steps;
}

// ── 결과를 앱이 쓰는 모양으로 ────────────────────────────────
export type EngineLeg = {
  type: "subway";
  line: string;
  color: string;
  start: string;
  end: string;
  stationCount: number;
  min: number;
  way: string;
  door: string;
  stationID: null;
  wayCode: null;
  stations: string[];
  estimated?: boolean;
};
export type EngineRoute = {
  totalTime: number;
  payment: number;
  transferCount: number;
  stationCount: number;
  legs: EngineLeg[];
};

function buildRoute(from: string, to: string, transferSec: number): EngineRoute | null {
  const steps = shortestPath(from, to, transferSec);
  if (!steps || steps.length < 2) return null;

  // 같은 노선끼리 묶어 구간(leg)으로 만듭니다.
  const legs: EngineLeg[] = [];
  let i = 0;
  while (i < steps.length - 1) {
    const line = steps[i + 1].line === steps[i].line ? steps[i].line : steps[i + 1].line;
    const stations = [steps[i].station];
    let j = i;
    while (j + 1 < steps.length && steps[j + 1].line === line && steps[j + 1].station !== steps[j].station) {
      stations.push(steps[j + 1].station);
      j++;
    }
    if (stations.length >= 2) {
      const startSec = steps[i].sec;
      const endSec = steps[j].sec;
      legs.push({
        type: "subway",
        line: shortLine(line),
        color: lineColor(line),
        start: DISPLAY.get(stations[0]) ?? stations[0],
        end: DISPLAY.get(stations[stations.length - 1]) ?? stations[stations.length - 1],
        stationCount: stations.length - 1,
        min: Math.max(1, Math.round((endSec - startSec) / 60)),
        way: DISPLAY.get(stations[stations.length - 1]) ?? "",
        door: "", // ODsay 고유 정보라 만들 수 없습니다
        stationID: null,
        wayCode: null,
        stations: stations.map((s) => DISPLAY.get(s) ?? s),
      });
    }
    i = j === i ? i + 1 : j;
  }
  if (!legs.length) return null;

  const totalSec = steps[steps.length - 1].sec;
  // 요금은 실제 이동 거리 기준
  let distance = 0;
  for (const leg of legs)
    for (let k = 0; k + 1 < leg.stations.length; k++) {
      const a = COORDS[leg.stations[k]];
      const b = COORDS[leg.stations[k + 1]];
      if (a && b) distance += km(a, b);
    }

  return {
    totalTime: Math.max(1, Math.round(totalSec / 60)),
    payment: fareFor(distance),
    transferCount: Math.max(0, legs.length - 1),
    stationCount: legs.reduce((n, l) => n + l.stationCount, 0),
    legs,
  };
}

// 여러 후보 경로.
//
// 앱에 최단시간 / 최소환승 / 최저요금 탭이 있어서 후보가 여럿 필요합니다.
// 환승에 매기는 시간을 달리해 탐색하면 성격이 다른 경로가 나옵니다.
//   3분  = 실제에 가까운 값 → 최단시간 경로
//   25분 = 환승을 아주 싫어하게 만듦 → 환승이 적은 경로
// 같은 경로가 나오면 하나만 남깁니다.
export function findRoutes(from: string, to: string): EngineRoute[] {
  const out: EngineRoute[] = [];
  const seen = new Set<string>();
  for (const t of [TRANSFER_SEC, 25 * 60, 10 * 60]) {
    const r = buildRoute(from, to, t);
    if (!r) continue;
    const sig = r.legs.map((l) => `${l.line}:${l.start}>${l.end}`).join("|");
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(r);
  }
  return out;
}

export function findRoute(from: string, to: string): EngineRoute | null {
  return findRoutes(from, to)[0] ?? null;
}
