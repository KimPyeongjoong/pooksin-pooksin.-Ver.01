// 아주 가까운 두 역 사이의 경로를 직접 만들어 줍니다.
//
// 왜 필요한가:
//   ODsay 경로검색은 출발·도착이 약 700m 안쪽이면 경로를 아예 주지 않습니다(오류 -98).
//   "걸어가라"는 뜻인데, 지하철 앱이 그걸 이유로 경로를 안 보여줄 수는 없습니다.
//   수도권 인접역 711쌍 중 41쌍이 여기 해당합니다(시청↔을지로입구, 동묘앞↔동대문 등).
//
// 어떻게 만드는가:
//   ① 노선도(linemap)에서 두 역이 같은 노선에 있는지, 몇 정거장인지 찾고
//   ② 서울교통공사 열차시간표에서 "같은 열차번호"가 두 역을 언제 출발하는지 비교해
//      실제 소요시간을 구합니다. (예: 2호선 시청→을지로입구 = 238편 전부 2분)
//   ③ 그 노선이 공공 시간표에 없으면(경전철 등) 거리로 대략 계산하고 그렇다고 표시합니다.

import linemap from "./linemap.json";
import coords from "./station-coords.json";
import { lineColor } from "./line-colors";

type Node = { x: number; y: number; name?: string };
type Line = { key: string; label: string; indicator: string; color: string; nodes: Node[] };
const LINES = linemap as Line[];
const COORDS = coords as Record<string, { x: number; y: number }>;

// 수도권 지하철 기본운임 (2026-08 기준). 요금이 바뀌면 이 값을 고쳐야 합니다.
const BASE_FARE = 1550;

// 공공 시간표에 노선명을 넘길 때 쓰는 이름 (linemap 표기와 다를 수 있어 맞춰줍니다)
const SCHEDULE_LINE_NAME: Record<string, string> = {
  "경의·중앙선": "경의중앙선",
  "우이신설경전철": "우이신설선",
  "서해": "서해선",
  "신림": "신림선",
};

export type ShortLeg = {
  type: "subway";
  line: string;
  color: string;
  start: string;
  end: string;
  stationCount: number;
  min: number;
  way: string;
  door: string;
  stations: string[];
  stationID: number | null;
  wayCode: number | null;
  estimated?: boolean; // 실제 시간표가 아니라 거리로 어림잡은 경우
};

export type ShortRoute = {
  totalTime: number;
  payment: number;
  transferCount: number;
  stationCount: number;
  legs: ShortLeg[];
};

// 두 역이 함께 있는 노선을 찾아 구간(정거장 목록)을 뽑습니다.
function findSegment(a: string, b: string) {
  for (const l of LINES) {
    const names: string[] = [];
    for (const n of l.nodes) if (n.name && !names.includes(n.name)) names.push(n.name);
    const i = names.indexOf(a);
    const j = names.indexOf(b);
    if (i < 0 || j < 0 || i === j) continue;
    const stations = i < j ? names.slice(i, j + 1) : names.slice(j, i + 1).reverse();
    return { line: l.label, color: l.color, stations };
  }
  return null;
}

// 직선거리(km)
function km(a: { x: number; y: number }, b: { x: number; y: number }) {
  const R = 6371;
  const r = Math.PI / 180;
  return R * Math.hypot((b.x - a.x) * r * Math.cos(((a.y + b.y) / 2) * r), (b.y - a.y) * r);
}

const toMin = (hhmmss: string) => {
  const [h, m] = hhmmss.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
};

// 공공 시간표에서 "역 → (열차번호 → 출발시각)" 표를 받아옵니다.
async function schedule(key: string, lineNm: string, updn: string, stnNm: string) {
  const qs = new URLSearchParams({
    numOfRows: "700", pageNo: "1", tmprTmtblYn: "N",
    upbdnbSe: updn, wkndSe: "평일", lineNm, stnNm,
  });
  const res = await fetch(`https://apis.data.go.kr/B553766/schedule/getTrainSch?serviceKey=${key}&${qs}`, {
    cache: "no-store",
  });
  const text = await res.text();
  const map = new Map<string, string>();
  let terminus = "";
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (k: string) => m[1].match(new RegExp(`<${k}>([^<]*)</${k}>`))?.[1] ?? "";
    if (get("stnNm") !== stnNm) continue; // 역명은 부분일치로 오므로 정확히 걸러냅니다
    map.set(get("trainno"), get("trainDptreTm"));
    if (!terminus) terminus = get("arvlStnNm");
  }
  return { map, terminus };
}

// 같은 열차번호가 두 역을 출발하는 시각 차이 = 실제 소요시간
//
// 방면(상행/하행/내선/외선)을 네 가지 다 시도해서, a→b 순서로 이동하는(차이가 양수인)
// 방면을 찾습니다. 종점역은 그 방향 출발 자료가 아예 없기도 해서 이렇게 훑어야 합니다.
async function realTravelMinutes(lineNm: string, a: string, b: string) {
  const key = process.env.SEOUL_METRO_API_KEY;
  if (!key) return null;
  for (const updn of ["상행", "하행", "내선", "외선"]) {
    try {
      const [A, B] = await Promise.all([
        schedule(key, lineNm, updn, a),
        schedule(key, lineNm, updn, b),
      ]);
      if (!A.map.size || !B.map.size) continue;
      const tally = new Map<number, number>();
      for (const [no, ta] of A.map) {
        const tb = B.map.get(no);
        if (!tb) continue;
        const d = toMin(tb) - toMin(ta);
        if (Number.isFinite(d)) tally.set(d, (tally.get(d) ?? 0) + 1);
      }
      const [best] = [...tally.entries()].sort((x, y) => y[1] - x[1]);
      // 차이가 양수여야 이 방면이 a → b 진행 방향입니다
      if (!best || best[0] <= 0) continue;
      return {
        min: best[0],
        updn,
        // 상행/외선 = 앱 규약상 up(1), 하행/내선 = down(2)
        wayCode: updn === "상행" || updn === "외선" ? 1 : 2,
        terminus: A.terminus, // 이 방면 열차의 종착역 = 방면 이름
        samples: best[1],
      };
    } catch {
      // 이 방면 자료가 없으면 다음 방면을 봅니다
    }
  }
  return null;
}

// 가까운 두 역 사이 경로 만들기 (못 만들면 null)
export async function buildShortRoute(from: string, to: string): Promise<ShortRoute | null> {
  const seg = findSegment(from, to);
  if (!seg) return null;

  const lineNm = SCHEDULE_LINE_NAME[seg.line] ?? seg.line;
  const real = await realTravelMinutes(lineNm, from, to);

  let min: number;
  let estimated = false;
  if (real) {
    min = real.min;
  } else {
    // 공공 시간표에 없는 노선(경전철 등)은 거리로 어림잡습니다 (표정속도 30km/h 가정)
    const a = COORDS[from];
    const b = COORDS[to];
    const d = a && b ? km(a, b) : 0.6;
    min = Math.max(1, Math.round((d / 30) * 60));
    estimated = true;
  }

  const stationCount = Math.max(1, seg.stations.length - 1);
  const leg: ShortLeg = {
    type: "subway",
    line: seg.line,
    color: seg.color || lineColor(seg.line),
    start: from,
    end: to,
    stationCount,
    min,
    way: real?.terminus || to,
    door: "",
    stations: seg.stations,
    stationID: null, // 이름으로 시간표를 찾도록 둡니다
    wayCode: real?.wayCode ?? null,
    ...(estimated ? { estimated: true } : {}),
  };

  return {
    totalTime: min,
    payment: BASE_FARE,
    transferCount: 0,
    stationCount,
    legs: [leg],
  };
}
