// "도착지까지 갈 수 있는 마지막 열차" 찾기
//
// 호출 예: /api/last-train?from=시청&to=가좌
//
// 왜 따로 만드나:
//   출발역의 막차를 아는 것만으로는 부족합니다. 그 열차를 타도 **환승 열차가 이미 끊겨**
//   도착지까지 못 가는 경우가 있기 때문입니다.
//
// 찾는 법 — **도착지 막차에서 거슬러 올라갑니다.**
//   ① 내장 시간표에서 **도착지의 마지막 열차 시각**을 봅니다. 그보다 늦게 출발해서는
//      어차피 도착할 수 없으니, 이게 출발 시각의 천장이 됩니다.
//   ② 내장 시간표에서 **출발역의 출발 시각들**을 천장 아래로 추려 **늦은 것부터** 하나씩
//      "이 열차로 가면 도착지까지 갈 수 있나?" 하고 물어봅니다.
//   ③ 처음 성공하는 것이 막차 경로입니다.
//   시간표는 앱에 들어 있어서 ①②는 공짜입니다. 실제 호출은 보통 한두 번으로 끝납니다.
//
//   (그래도 못 찾으면 마지막 수단으로 시간 구간을 반씩 좁혀가며 찾습니다.)

import { dayTypeOf } from "@/lib/holidays";
import { linesAtStation } from "@/lib/lines";
import { shortLine } from "@/lib/line-colors";
import { findPath } from "@/lib/shortest-path";
import { stationTimetable } from "@/lib/timetable";

const SEARCH_END = 26 * 60; // 다음날 새벽 2시까지만 봅니다 (막차는 보통 1시 전)
const MAX_TRIES = 8; // 늦은 열차부터 이만큼만 물어봅니다

// 자정 기준 분 → 실제 날짜·시각 (1440을 넘으면 다음날)
function dateOf(min: number) {
  const d = new Date();
  d.setHours(Math.floor(min / 60) % 24, min % 60, 0, 0);
  if (min >= 24 * 60) d.setDate(d.getDate() + 1);
  return d;
}

// ⚠️ findPath 는 "경로가 없음"과 "부르다 실패함"을 둘 다 null 로 돌려줍니다.
//    없다고 나오면 막차를 너무 이르게 잡을 수 있어 한 번 더 물어봅니다.
async function pathAt(from: string, to: string, min: number) {
  const off = min >= 24 * 60 ? 24 * 60 : 0;
  const first = await findPath(from, to, dateOf(min), "duration", off);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 150));
  return await findPath(from, to, dateOf(min), "duration", off);
}

// 그 역의 출발 시각 전부 (지나는 노선·양방향을 합쳐서). 내장 시간표라 외부 호출이 없습니다.
async function departuresOf(station: string): Promise<number[]> {
  const day = dayTypeOf();
  const out = new Set<number>();
  for (const l of linesAtStation(station)) {
    const t = await stationTimetable(station, shortLine(l.label));
    if (!t) continue;
    for (const way of ["up", "down"] as const)
      for (const d of t.lists[day][way]) out.add(d.min);
  }
  return [...out].sort((a, b) => a - b);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  if (!from || !to) return Response.json({ error: "from 과 to 가 필요해요" }, { status: 400 });

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // ① 도착지의 마지막 열차 = 출발 시각의 천장
  //    (도착지에 서는 마지막 열차보다 늦게 출발하면 도착할 방법이 없습니다)
  const destTimes = await departuresOf(to);
  const ceiling = Math.min(destTimes[destTimes.length - 1] ?? SEARCH_END, SEARCH_END);

  // ② 출발역의 출발 시각을 천장 아래로 추려 늦은 것부터
  const origin = (await departuresOf(from))
    .filter((t) => t >= nowMin && t <= ceiling)
    .sort((a, b) => b - a);

  let tried = 0;
  for (const t of origin.slice(0, MAX_TRIES)) {
    tried++;
    const r = await pathAt(from, to, t);
    if (r) {
      return Response.json({
        min: r.legs[0].boardMin,
        arriveMin: r.legs[r.legs.length - 1].arriveMin,
        line: r.legs[0].line,
        tried,
        how: "backward",
      });
    }
  }

  // ③ 여기까지 못 찾았으면(시간표가 없는 역 등) 구간을 반씩 좁혀가며 찾습니다
  let lo = nowMin;
  let hi = SEARCH_END;
  const nowPath = await pathAt(from, to, lo);
  tried++;
  if (!nowPath) {
    // ⚠️ "막차가 끊겼다"와 "이 구간을 경로검색 API가 모른다"를 구분해야 합니다.
    //    용인경전철처럼 API가 다루지 않는 역이면 한낮에도 아무 답을 못 받는데,
    //    그걸 "끊겼다"고 하면 틀린 말이 됩니다.
    //    출발역에 아직 남은 열차가 있으면 끊긴 게 아닙니다.
    const originLeft = (await departuresOf(from)).some((t) => t >= nowMin);
    return Response.json({
      min: null,
      reason: originLeft
        ? "이 구간은 막차를 확인하지 못했어요"
        : "오늘은 이 방향 막차가 이미 끊겼어요",
      tried,
    });
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    tried++;
    if (await pathAt(from, to, mid)) lo = mid;
    else hi = mid;
  }
  const last = (await pathAt(from, to, lo)) ?? nowPath;
  return Response.json({
    min: last.legs[0].boardMin,
    arriveMin: last.legs[last.legs.length - 1].arriveMin,
    line: last.legs[0].line,
    tried,
    how: "narrow",
  });
}
