// 경로검색 — 서울교통공사 "지하철역 최단경로이동정보" (서버에서만 씁니다)
//
// 출처: 서울열린데이터광장 OA-22724 (공공데이터포털 15143842와 같은 서비스)
//   http://openapi.seoul.go.kr:8088/{키}/json/getShtrmPath/1/5/{출발역}/{도착역}/{일시}[/duration|transfer]
//   키: .env.local 의 SEOUL_PATH_API_KEY
//
// 이 API 하나가 우리가 직접 만들던 걸 거의 다 줍니다.
//   · 구간별 **실제 열차 시각**(trainDptreTm/trainArvlTm)과 열차번호
//   · 상행/하행(upbdnbSe) · 행선지(tmnlStnNm)
//   · 환승 **걸어가는 시간**(reqHr)과 **기다리는 시간**(wtngHr)
//   · 카드 요금(totalCardCrg) — 신분당선 별도운임까지 반영
//   · 통과역(nonstopYn="Y") → 그 구간이 급행이라는 뜻
//
// ⚠️ 일시는 **초까지** 있어야 합니다. 날짜만 주면 resultCode 11 이 옵니다.
// ⚠️ 막차가 끊긴 시각을 물으면 resultCode 00 에 paths가 **빈 배열**로 옵니다.
// ⚠️ 하루 1,000건 한도(서울열린데이터광장 기본값) — 같은 질문은 서버에서 캐시합니다.
//
// 이 API가 **안 주는 것**(그래서 우리 자료를 계속 씁니다):
//   실시간 지연 · 빠른 환승 칸(몇 호차 몇 번 문) · 좌석

import { lineColor, shortLine } from "./line-colors";

const BASE = "http://openapi.seoul.go.kr:8088";

// API 응답에서 한 줄(역 → 다음 역)
type RawStn = { stnCd: string; stnNo: string; stnNm: string; lineNm: string | null };
type RawPath = {
  dptreStn: RawStn;
  arvlStn: RawStn;
  stnSctnDstc: number; // 구간 거리(m)
  reqHr: number; // 소요(초) — 환승 줄에서는 걸어가는 시간
  wtngHr: number; // 대기(초)
  tmnlStnNm: string | null; // 행선지
  upbdnbSe: string | null; // 상행/하행(2호선은 내선/외선)
  trainno: string | null;
  trainDptreTm: string | null;
  trainArvlTm: string | null;
  trsitYn: "Y" | "N";
  nonstopYn: "Y" | "N"; // Y면 도착역을 **통과**합니다(= 급행)
};
type RawBody = {
  searchType: string;
  totalDstc: number;
  totalReqHr: number; // 초
  totalCardCrg: number;
  trsitNmtm: number;
  paths: RawPath[];
};

export type PathLeg = {
  type: "subway";
  line: string; // 앱에서 쓰는 이름 (급행이면 "1호선(급행)")
  color: string;
  start: string;
  end: string;
  stationCount: number;
  min: number; // 승차 → 하차
  way: string; // 방면(행선지)
  door: string; // 빠른 환승 칸 — 이 파일에서는 비워두고 /api/route 가 채웁니다
  stationID: null;
  wayCode: 1 | 2 | null;
  stations: string[]; // 정차역만 (통과역은 뺍니다)
  boardMin: number; // 자정 기준 분
  arriveMin: number;
  transferMin?: number; // 앞 구간에서 여기까지 걸어온 시간
  waitMin?: number; // 승강장에서 기다린 시간
  trainNo?: string;
  express?: boolean;
};

export type PathRoute = {
  totalTime: number;
  payment: number | null; // GTX가 낀 경로는 null (별도 운임이라 값을 안 줍니다)
  transferCount: number;
  stationCount: number;
  departMin: number;
  arriveMin: number;
  distance: number; // m
  searchType: string;
  legs: PathLeg[];
  source: "api";
};

// "08:39:00" → 자정 기준 분. 자정을 넘긴 열차는 1440을 더해 이어지게 합니다.
function toMin(hhmmss: string | null, baseMin: number): number {
  if (!hhmmss) return NaN;
  const [h, m] = hhmmss.split(":").map(Number);
  if (!Number.isFinite(h)) return NaN;
  let min = h * 60 + (m || 0);
  // 질문한 시각보다 두 시간 넘게 이르면 다음날 새벽 열차로 봅니다
  if (min < baseMin - 120) min += 24 * 60;
  return min;
}

// 요금을 보여주면 안 되는 노선 (GTX는 별도 운임이라 이 API가 0원으로 줍니다)
const NO_FARE_LINES = new Set(["GTX-A"]);

// ⚠️ 이 API에 보낼 역 이름 다듬기 (실측으로 확인한 규칙)
//   · **괄호가 붙으면 못 찾습니다**: "총신대입구(이수)" ❌ / "총신대입구" ✅,
//     "사우(김포시청)" ❌ / "사우" ✅, "관악산(서울대)" ❌ / "관악산" ✅
//   · **"서울"은 위험합니다** — 엉뚱하게 걸려 "0분" 경로가 나옵니다. "서울역"으로 보내야 합니다.
const SEND_ALIAS: Record<string, string> = { 서울: "서울역" };
const apiName = (s: string) => {
  const bare = (s || "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return SEND_ALIAS[bare] ?? bare;
};

// 이름이 비슷해서 엉뚱한 역이 잡혔는지 확인 (공백·괄호·끝의 "역"을 떼고 비교)
const same = (a: string, b: string) => {
  const k = (s: string) =>
    (s || "").replace(/\s/g, "").replace(/[·.]/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "");
  return k(a) === k(b);
};

function parse(body: RawBody, baseMin: number): PathRoute | null {
  const rows = body?.paths ?? [];
  if (!rows.length) return null;

  const legs: PathLeg[] = [];
  let cur: PathLeg | null = null;
  let pendingWalk = 0; // 환승 줄에서 읽은 걸어가는 시간(분)
  let pendingWait = 0;

  for (const p of rows) {
    if (p.trsitYn === "Y") {
      // 환승 줄 — 역은 같고 노선만 바뀝니다. 여기서 걷고 기다립니다.
      pendingWalk = Math.round((p.reqHr || 0) / 60);
      pendingWait = Math.round((p.wtngHr || 0) / 60);
      cur = null;
      continue;
    }
    const lineNm = shortLine(p.dptreStn.lineNm ?? "");
    if (!cur || cur.line.replace(/\(급행\)$/, "") !== lineNm) {
      cur = {
        type: "subway",
        line: lineNm,
        color: lineColor(lineNm),
        start: p.dptreStn.stnNm,
        end: p.arvlStn.stnNm,
        stationCount: 0,
        min: 0,
        way: p.tmnlStnNm ?? "",
        door: "",
        stationID: null,
        wayCode: /하행|내선/.test(p.upbdnbSe ?? "") ? 2 : 1,
        stations: [p.dptreStn.stnNm],
        boardMin: toMin(p.trainDptreTm, baseMin),
        arriveMin: NaN,
        trainNo: p.trainno ?? undefined,
        express: false,
      };
      if (pendingWalk || pendingWait) {
        cur.transferMin = pendingWalk;
        cur.waitMin = pendingWait;
        pendingWalk = 0;
        pendingWait = 0;
      }
      legs.push(cur);
    }
    cur.stationCount++;
    // ⚠️ 통과역은 정차역 목록에 넣지 않습니다 (nonstopYn="Y" = 그 역을 지나칩니다)
    if (p.nonstopYn === "Y") cur.express = true;
    else {
      cur.stations.push(p.arvlStn.stnNm);
      cur.end = p.arvlStn.stnNm;
      cur.arriveMin = toMin(p.trainArvlTm, baseMin);
    }
  }

  for (const l of legs) {
    // 급행이면 화면에서도 구분되게 이름에 붙입니다 (실시간 목록도 급행만 보게 됩니다)
    if (l.express && !/\(급행\)$/.test(l.line)) {
      l.line = `${l.line}(급행)`;
      l.color = lineColor(l.line);
    }
    if (!Number.isFinite(l.arriveMin)) l.arriveMin = l.boardMin + Math.max(1, l.stationCount * 2);
    l.min = Math.max(1, l.arriveMin - l.boardMin);
    // 통과역을 뺐으므로 "몇 정거장"은 정차역 기준으로 다시 셉니다
    l.stationCount = Math.max(1, l.stations.length - 1);
  }
  if (!legs.length) return null;

  const departMin = legs[0].boardMin;
  const arriveMin = legs[legs.length - 1].arriveMin;
  const noFare = legs.some((l) => NO_FARE_LINES.has(shortLine(l.line)));
  return {
    totalTime: Math.max(1, arriveMin - departMin),
    payment: noFare ? null : body.totalCardCrg || null,
    transferCount: Math.max(0, legs.length - 1),
    stationCount: legs.reduce((n, l) => n + l.stationCount, 0),
    departMin,
    arriveMin,
    distance: body.totalDstc ?? 0,
    searchType: body.searchType ?? "duration",
    legs,
    source: "api",
  };
}

// 같은 질문을 여러 사람이 해도 API는 한 번만 부르도록 (하루 1,000건 한도)
const cache = new Map<string, { at: number; route: PathRoute | null }>();
const CACHE_MS = 60_000; // 1분 — 시각이 지나면 답이 달라지므로 짧게

export type PathSearchType = "duration" | "transfer";

export async function findPath(
  from: string,
  to: string,
  when: Date,
  type: PathSearchType = "duration"
): Promise<PathRoute | null> {
  const key = process.env.SEOUL_PATH_API_KEY;
  if (!key) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ` +
    `${p(when.getHours())}:${p(when.getMinutes())}:00`;
  const baseMin = when.getHours() * 60 + when.getMinutes();

  const q1 = apiName(from);
  const q2 = apiName(to);
  const ck = `${q1}|${q2}|${stamp}|${type}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.route;

  const url =
    `${BASE}/${key}/json/getShtrmPath/1/5/` +
    `${encodeURIComponent(q1)}/${encodeURIComponent(q2)}/${encodeURIComponent(stamp)}/${type}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json();
    if (json?.header?.resultCode !== "00") {
      // 10 = 역 이름을 못 찾음, 11 = 일시 형식 오류
      return null;
    }
    const route = parse(json.body as RawBody, baseMin);
    // ⚠️ 이름이 비슷한 다른 역이 잡혔으면 버립니다 (예: "서울"을 물으면 엉뚱한 0분 경로가 옵니다).
    //    버리면 /api/route 가 우리 엔진으로 넘어갑니다.
    const ok =
      route &&
      same(route.legs[0].start, from) &&
      same(route.legs[route.legs.length - 1].end, to) &&
      route.totalTime > 0;
    if (!ok) {
      cache.set(ck, { at: Date.now(), route: null });
      return null;
    }
    cache.set(ck, { at: Date.now(), route });
    if (cache.size > 500) cache.clear();
    return route;
  } catch {
    return null;
  }
}
