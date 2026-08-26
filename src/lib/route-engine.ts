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
//     ⑤ 급행 정보(express.json)         — 급행이 어디에 서는지 + 급행 구간 소요시간
//
// 못 하는 것 (정직하게):
//   - **요금**: 지금은 거리비례 공식으로 계산합니다.
//     서울교통공사 실시간운임정보(data.go.kr 15143846)를 붙이면 정확해집니다.

import linemap from "./linemap.json";
import coordsJson from "./station-coords.json";
import sectionJson from "./section-times.json";
import expressJson from "./express.json";
import transferJson from "./transfers.json";
import extraJson from "./transfers-extra.json";
import walkJson from "./transfer-times.json";
import kricJson from "./transfer-times-kric.json";
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

// 환승 거리·소요시간 (서울교통공사 "환승역거리 소요시간 정보" OA-13290).
// 호차·문은 없지만, 위 자료에 없는 **코레일·민자 노선으로 갈아타는 경우**가 들어 있습니다.
// 값은 환승연결통로 최단거리를 보행속도 1.2m/s로 나눈 공식 계산값입니다.
const WALK = (
  walkJson as { stations: Record<string, Record<string, Record<string, { sec: number; m: number | null }>>> }
).stations;

// 레일포털(KRIC) "역사별 환승정보"로 채우려던 자리 — **지금은 비어 있습니다.**
// 위 둘은 서울교통공사 자료라 **양쪽 다 서울교통공사가 아닌 환승**(회기·용산·부평·김포공항 등)이 비는데,
// 레일포털은 전국 철도운영기관을 덮어서 환승거리를 같은 기준(1.2m/s)으로 환산하려 했습니다.
// 그런데 레일포털의 환승거리 항목(chtnDst)이 **전국 1049행 전부 null** 이었습니다 (2026-08-26 전수 확인).
// 그래서 그 환승들은 계속 아래 EXTRA 나 3분 상수로 갑니다.
// (사정과 알아낸 API 사용법은 scripts/build-transfers-kric.mjs 맨 위 주석에)
const KRIC = (
  kricJson as { stations: Record<string, Record<string, Record<string, { sec: number; m: number | null }>>> }
).stations;

// 위 자료들에도 없는 환승(GTX-A 등)을 예전에 재서 채워둔 값. 초 단위.
const EXTRA = (extraJson as { stations: Record<string, Record<string, Record<string, number>>> })
  .stations;

// 그 역에서 A노선 → B노선 환승에 걸리는 시간(초).
// ① 환승정보(호차·문까지) → ② 환승역거리 → ③ 레일포털 → ④ 예전에 재둔 보충값 → ⑤ 그래도 없으면 상수
export function transferSecOf(station: string, from: string, to: string): number {
  // 같은 노선의 급행 ↔ 완행은 "환승"이 아니라 승강장에서 기다리는 것입니다.
  // 기다리는 시간은 **타려는 쪽**의 배차에 달렸습니다(뜸한 급행으로 갈아타면 오래 기다림).
  if (baseLine(from) === baseLine(to)) return waitFor(to);
  const cases = transferCases(station, baseLine(from), baseLine(to));
  if (cases.length) {
    const v = cases.map((c) => c.sec).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)]; // 방향마다 조금씩 달라 중앙값
  }
  const a = shortLine(baseLine(from));
  const b = shortLine(baseLine(to));
  const walk = WALK[norm(station)]?.[a]?.[b];
  if (walk?.sec) return walk.sec;
  const kric = KRIC[norm(station)]?.[a]?.[b];
  if (kric?.sec) return kric.sec;
  const extra = EXTRA[norm(station)]?.[a]?.[b];
  return extra ?? TRANSFER_SEC;
}

// 역 이름 표기 차이 흡수 (src/lib/timetable.ts 와 같은 규칙)
const NAME_ALIAS: Record<string, string> = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s: string) =>
  (s || "")
    .replace(/\s/g, "")
    .replace(/[·.]/g, "") // 노선도 "시청·용인대" ↔ 시간표 "시청.용인대"
    .replace(/\([^)]*\)/g, "")
    .replace(/역$/, "")
    .trim();
export const norm = (s: string) => NAME_ALIAS[bare(s)] ?? bare(s);

// ── 조정 가능한 값 ───────────────────────────────────────────
const TRANSFER_SEC = 180; // 환승 1회에 잡는 시간 (공공 데이터 없음 → 임시 상수)
const DEFAULT_SPEED_KMH = 32; // 구간 소요시간이 없을 때 거리로 추정할 때 쓰는 표정속도
const BOARD_WAIT_SEC = 0; // 승차 대기는 시간표 화면에서 따로 다룹니다

// ── 이름만 같고 실제로는 다른 역 ─────────────────────────────
//
// ⚠️ 수도권에는 **이름이 같은 다른 역**이 있습니다.
//    5호선 양평역(서울 영등포구) 과 경의중앙선 양평역(경기 양평군) — 40km 떨어져 있습니다.
//    이름만 보고 환승역으로 묶으면 "여의도 → 용문 21분" 같은 있을 수 없는 경로가 나옵니다.
//    (실제로는 한 시간 반이 넘습니다)
//
// 가려내는 법: 노선도에 그려진 위치를 봅니다. 진짜 환승역은 같은 자리(또는 바로 옆)에 그려지는데,
// 양평은 187만큼 떨어져 있습니다. 그다음으로 먼 신촌(2호선↔경의중앙선)이 14이니 사이가 넉넉합니다.
// 신촌처럼 걸어서 갈아탈 수 있는 곳은 그대로 두고, 확실히 다른 역만 끊습니다.
const SPLIT_DIST = 30;
const SPLIT = new Set<string>(); // "역|노선A|노선B"
const splitKey = (s: string, a: string, b: string) => `${s}|${a}|${b}`;
// 역 → 노선 → 노선도에 그려진 자리
const NODE_AT = new Map<string, Map<string, { x: number; y: number }>>();

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

// ── 급행 ────────────────────────────────────────────────────
//
// 자료: src/lib/express.json (scripts/build-timetable.mjs 가 만듭니다)
//   공공 시간표 원본에서 **"도착시각이 있는 역 = 서는 역"**으로 급행을 가려낸 결과입니다.
//   한 노선에 갈래가 여럿일 수 있습니다 — 1호선만 해도 경인급행·경인특급·경부급행이 따로 다닙니다.
//
// 급행은 완행과 **다른 노선처럼** 다룹니다.
//   ① 급행은 서는 역이 달라서, 안 서는 역에서 타고 내릴 수 없습니다.
//   ② 완행에서 급행으로 갈아타려면 승강장에서 기다려야 합니다(공짜가 아님).
// 이름 뒤에 "(급행)"·"(특급)"을 붙여 구분합니다. 화면에 그대로 보여도 자연스럽습니다.
type ExpressService = {
  id: string; // 자료 안에서 갈래를 구분하는 이름 (급행 / 급행2 / 특급 …)
  name: string; // 화면에 보일 이름 (급행 또는 특급)
  span: string; // 다니는 구간 ("동인천~용산")
  trains: number;
  wd: number; // 평일 운행 대수 (양방향 합)
  we: number; // 주말 운행 대수
  ways: string[];
  stops: string[];
  skips: string[];
  edges: Record<string, number>; // "부천|역곡" → 초
};
// (JSON을 그대로 읽으면 노선마다 구간 이름이 달라 타입이 제각각이라 unknown을 거칩니다)
const EXPRESS =
  (expressJson as unknown as { lines: Record<string, ExpressService[]> }).lines ?? {};

// 하루에 이보다 적게 다니는 갈래는 경로 계산에 넣지 않습니다.
// (하루 두세 번 다니는 열차를 "이게 제일 빨라요"라고 하면 안 되니까요. 시간표 화면에는 그대로 나옵니다.)
const EXPRESS_MIN_TRAINS = 10;

// 가상의 급행 노선 이름 → 원래 노선 · 화면에 쓸 이름 · 기다리는 시간
const EX_LINE = new Map<string, { base: string; label: string; wait: number }>();
export const isExpress = (line: string) => EX_LINE.has(line);
export const baseLine = (line: string) => EX_LINE.get(line)?.base ?? line;

// 승강장에서 기다리는 시간.
//   완행은 자주 오니 상수(3분 30초)로 두고,
//   급행은 하루 운행 대수로 배차 간격을 어림해 그 절반(평균 기다림)을 잡습니다.
//   예) 경인급행은 평일 한 방향 90대 → 배차 약 13분 → 기다림 6분 반
// 이걸 안 넣으면 한두 정거장 아끼려고 뜸한 급행을 타라는 경로가 나옵니다.
const EXPRESS_WAIT_SEC = 210;
const OPEN_HOURS_SEC = 19 * 3600; // 첫차부터 막차까지
const waitFor = (line: string) => EX_LINE.get(line)?.wait ?? EXPRESS_WAIT_SEC;

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
      // 이름이 같은 역이 노선마다 어디에 그려져 있는지 (아래에서 "다른 역"을 가려내는 데 씁니다)
      if (!NODE_AT.has(cur)) NODE_AT.set(cur, new Map());
      if (!NODE_AT.get(cur)!.has(line)) NODE_AT.get(cur)!.set(line, { x: n.x, y: n.y });
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

  // 이름만 같고 실제로는 다른 역을 찾아 환승을 끊어둡니다 (위 SPLIT_DIST 설명 참고).
  for (const [station, byLine] of NODE_AT) {
    const ls = [...byLine];
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++) {
        const [la, pa] = ls[i];
        const [lb, pb] = ls[j];
        if (Math.hypot(pa.x - pb.x, pa.y - pb.y) <= SPLIT_DIST) continue;
        SPLIT.add(splitKey(station, la, lb));
        SPLIT.add(splitKey(station, lb, la));
      }
  }

  // 급행 노선을 따로 얹습니다.
  //
  // express.json 의 `edges` 는 **급행이 실제로 달린 구간**(선 정차역 → 다음 정차역)과
  // 그 소요시간입니다. 그대로 이어 붙이면 급행 노선이 됩니다.
  // 급행이 건너뛰지 않는 구간(구로~용산처럼)도 그 안에 들어 있어 노선이 끊기지 않습니다.
  for (const [base, services] of Object.entries(EXPRESS)) {
    for (const svc of services) {
      if (svc.trains < EXPRESS_MIN_TRAINS) continue;
      const edges = Object.entries(svc.edges ?? {});
      if (edges.length < 2) continue;
      const exLine = `${base}(${svc.id})`;
      const perDir = Math.max(1, (svc.wd || svc.trains) / Math.max(1, svc.ways.length));
      const wait = Math.min(900, Math.max(180, Math.round(OPEN_HOURS_SEC / perDir / 2)));
      EX_LINE.set(exLine, { base, label: `${shortLine(base)}(${svc.name})`, wait });

      for (const [k, sec] of edges) {
        const [a, b] = k.split("|").map(norm);
        if (!a || !b || a === b) continue;
        for (const s of [a, b]) {
          if (!LINES_AT.has(s)) LINES_AT.set(s, new Set());
          LINES_AT.get(s)!.add(exLine);
        }
        if (!GRAPH.has(a)) GRAPH.set(a, []);
        if (!GRAPH.has(b)) GRAPH.set(b, []);
        GRAPH.get(a)!.push({ to: b, line: exLine, sec });
        GRAPH.get(b)!.push({ to: a, line: exLine, sec });
      }
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
    // 출발역에서 바로 급행을 타는 경우에도, 급행이 완행보다 뜸한 만큼은 더 기다립니다.
    const d = BOARD_WAIT_SEC + Math.max(0, waitFor(line) - EXPRESS_WAIT_SEC);
    dist.set(k, d);
    push(k, d);
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
      // 이름만 같고 실제로는 다른 역이면 갈아탈 수 없습니다 (양평 5호선 ↔ 경의중앙선)
      if (SPLIT.has(splitKey(station, baseLine(line), baseLine(other)))) continue;
      const nk = keyOf({ station, line: other });
      // 역마다 실제 환승 시간이 다릅니다(1분~22분). 자료에 있으면 그 값을 씁니다.
      const walk = transferSec === TRANSFER_SEC ? transferSecOf(station, line, other) : transferSec;
      // 다른 노선에서 갈아타 급행을 타는 경우에도, 급행이 뜸한 만큼은 더 기다립니다.
      // (같은 노선의 완행↔급행은 위 transferSecOf 가 이미 기다리는 시간으로 계산합니다)
      const extraWait =
        baseLine(line) === baseLine(other) ? 0 : Math.max(0, waitFor(other) - EXPRESS_WAIT_SEC);
      const nd = d + walk + extraWait;
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
        // shortLine이 괄호를 떼어내므로 급행 표시는 따로 붙여줍니다 ("1호선(급행)")
        line: EX_LINE.get(line)?.label ?? shortLine(line),
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
