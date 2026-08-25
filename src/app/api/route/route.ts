// 지하철 경로검색 서버 경로
// 호출 예: /api/route?from=강남&to=사당
//
// 전부 앱 안의 자료로 계산합니다. 외부 API 호출은 요금 조회 하나뿐입니다.
//   경로·시간  → src/lib/route-engine.ts (노선도 + 구간 소요시간 + 환승 자료)
//   상행/하행  → src/lib/timetable.ts    (내장 시간표의 행선지로 판별)
//   요금       → src/lib/fare.ts         (서울교통공사 실시간운임정보)
//
// ⚠️ ODsay는 쓰지 않습니다.
//    무료 플랜이 하루 1,000건에서 **30건**으로 바뀌어 사실상 쓸 수 없게 됐습니다.
//    (2026-08-22~23에 걸쳐 27시간 넘게 한도 초과 상태였습니다)
//    예전에 ODsay만 주던 정보는 이렇게 대체했습니다.
//      경로검색   → 직접 계산
//      빠른 환승 칸 → 서울교통공사 환승정보(OA-22521)
//      환승 소요시간 → 같은 자료 (없는 조합은 3분 상수)

import { findRoutes, knownStation, transferCases, transferSecOf } from "@/lib/route-engine";
import { findPath } from "@/lib/shortest-path";
import { directionFor } from "@/lib/timetable";
import { lineStations } from "@/lib/lines";
import { lookupFare } from "@/lib/fare";
import { shortLine } from "@/lib/line-colors";

// 기본운임 외에 별도 요금을 더 받는 노선들 (운임 API의 addCrgExpln 설명 기준)
const EXTRA_FARE_LINES = new Set(["신분당선", "의정부경전철", "용인경전철", "우이신설선", "김포골드라인"]);

type Fail = { error: string; kind: "same" | "notFound"; options: [] };
const fail = (kind: Fail["kind"], error: string, status = 200) =>
  Response.json({ error, kind, options: [] }, { status });

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!from || !to) return fail("notFound", "출발역과 도착역이 필요해요", 400);
  if (from === to) return fail("same", "출발역과 도착역이 같습니다");
  if (!knownStation(from) || !knownStation(to)) {
    return fail("notFound", "노선도에 없는 역이에요");
  }

  // ── ① 공공 API 먼저 ─────────────────────────────────────────
  //
  // 서울교통공사 "최단경로이동정보"는 경로를 통째로 줍니다 —
  // 구간별 **실제 열차 시각**·상하행·행선지·통과역(급행)·환승 걸음/대기·요금까지.
  // 우리가 직접 계산하던 것보다 정확합니다(시간표를 그대로 쓰니까요).
  //
  // `at`(출발 기준 시각)을 받으면 그 시각 이후로 탈 수 있는 열차로 답해줍니다.
  const at = searchParams.get("at"); // "1320" (자정 기준 분) 또는 비움 = 지금
  const when = new Date();
  // ⚠️ `at`이 없을 때 Number(null)은 0이라 자정(00:00)으로 물어보게 됩니다.
  //    그러면 막차가 끊긴 시각이라 대부분 "경로 없음"이 돼 폴백으로 새 버렸습니다.
  const atMin = at ? Number(at) : NaN;
  if (Number.isFinite(atMin) && atMin >= 0) {
    when.setHours(Math.floor(atMin / 60) % 24, atMin % 60, 0, 0);
    if (atMin >= 24 * 60) when.setDate(when.getDate() + 1); // 자정 넘긴 시각
  }
  // 내일 시각을 물어봤으면(자정 기준 분이 1440 이상) 돌려주는 시각에도 그만큼 더합니다
  const dayOffset = Number.isFinite(atMin) && atMin >= 24 * 60 ? 24 * 60 : 0;
  const api = (
    await Promise.all([
      findPath(from, to, when, "duration", dayOffset),
      findPath(from, to, when, "transfer", dayOffset),
    ])
  ).filter((r): r is NonNullable<typeof r> => !!r);
  // 같은 경로가 두 번 나오면 하나만 남깁니다
  const seen = new Set<string>();
  const apiOptions = api.filter((r) => {
    const sig = r.legs.map((l) => `${l.line}:${l.start}>${l.end}`).join("|");
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });

  // ── ② API가 답을 못 주면 우리 엔진으로 ──────────────────────
  //    (한도 초과·장애·이 API가 모르는 역일 때. 자료는 앱 안에 있으니 멈추지 않습니다)
  const options = apiOptions.length ? apiOptions : findRoutes(from, to);
  if (!options.length) return fail("notFound", "경로를 찾지 못했어요");
  const fromApi = apiOptions.length > 0;

  for (const o of options) {
    for (const leg of o.legs) {
      // 상행/하행. 이게 없으면 "곧 오는 열차"에 반대 방향 열차가 뜹니다.
      // (5호선 종로3가에서 동대문역사문화공원으로 가는데 "방화행"이 뜨던 문제)
      // API 경로는 upbdnbSe 로 이미 채워져 있어 다시 구하지 않습니다.
      if (leg.wayCode == null)
        (leg as { wayCode: number | null }).wayCode = await directionFor(leg.line, leg.start, leg.end);
    }
    // 빠른 환승 칸 — "이 칸에 타고 있으면 다음 환승이 빠릅니다".
    // 환승역에서 내리는 위치(호차-문)를 그 앞 구간에 붙여줍니다.
    for (let i = 0; i + 1 < o.legs.length; i++) {
      const here = o.legs[i];
      const next = o.legs[i + 1];
      // 환승역에서 걸어가는 데 걸리는 시간 (화면의 회색 구간에 적습니다).
      // 서울교통공사 환승정보·환승역거리에서 온 실제 값이고, 없으면 3분 상수입니다.
      // (API 경로는 이미 실제 값을 갖고 있어 건드리지 않습니다)
      if ((next as { transferMin?: number }).transferMin == null)
        (next as { transferMin?: number }).transferMin = Math.max(
          1,
          Math.round(transferSecOf(here.end, here.line, next.line) / 60)
        );
      const cases = transferCases(here.end, here.line, next.line);
      if (!cases.length) continue;
      // 같은 역이라도 어느 방향에서 왔느냐에 따라 내리는 칸이 다릅니다.
      // 이 구간이 진행하던 방향의 다음 역 이름으로 골라냅니다.
      const order = lineStations(here.line);
      const iEnd = order.indexOf(here.end);
      const iPrev = order.indexOf(here.stations[here.stations.length - 2] ?? here.start);
      const ahead = iEnd >= 0 && iPrev >= 0 ? order[iEnd + Math.sign(iEnd - iPrev)] : undefined;
      const hit =
        (ahead ? cases.find((c) => c.fromWay === ahead.replace(/\s/g, "")) : undefined) ?? cases[0];
      (here as { door: string }).door = hit.off;
    }
  }

  // 요금을 공식 값으로 바꿔줍니다. 못 받으면 엔진이 계산한 거리비례 값을 그대로 둡니다.
  //
  // ⚠️ `gnrlCardFare`는 **거리 요금만**이고 별도운임 노선의 추가요금은 빠져 있습니다.
  //    (강남→판교 14.2km = 1,650원 = 거리 공식값 그대로. 신분당선 1,000원이 빠짐)
  //    그래서 그 경로가 실제로 별도운임 노선을 탈 때만 더해줍니다.
  // API 경로는 요금(totalCardCrg)을 이미 갖고 있어 그대로 씁니다.
  // ⚠️ GTX가 낀 경로는 payment 가 null 입니다 — **요금을 아예 표시하지 않습니다**(별도 운임이라 값이 없음).
  const fare = fromApi ? null : await lookupFare(from, to);
  if (fare) {
    for (const o of options) {
      const usesExtra = o.legs.some((l) => EXTRA_FARE_LINES.has(shortLine(l.line)));
      o.payment = fare.card + (usesExtra ? fare.addFare : 0);
    }
  }

  return Response.json({ from, to, source: fromApi ? "api" : "engine", options, fare });
}
