// "도착지까지 갈 수 있는 마지막 열차" 찾기
//
// 호출 예: /api/last-train?from=시청&to=가좌
//
// 왜 따로 만드나:
//   출발역의 막차를 아는 것만으로는 부족합니다. 그 열차를 타도 **환승 열차가 이미 끊겨**
//   도착지까지 못 가는 경우가 있기 때문입니다.
//   경로검색 API는 "이 시각 이후로 갈 수 있는 길"을 알려주므로,
//   **늦은 시각일수록 길이 없어집니다.** 그 경계를 찾으면 그게 막차 경로입니다.
//
// 찾는 법(이분 탐색):
//   지금 ~ 다음날 새벽 2시 사이에서 "경로가 있는 가장 늦은 시각"을 반씩 좁혀가며 찾습니다.
//   전체를 1분씩 훑으면 수백 번 불러야 하지만, 이렇게 하면 열 번 안쪽입니다.

import { findPath } from "@/lib/shortest-path";

const SEARCH_END = 26 * 60; // 다음날 새벽 2시까지 봅니다 (막차는 보통 1시 전)

// 자정 기준 분 → 실제 날짜·시각 (1440을 넘으면 다음날)
function dateOf(min: number) {
  const d = new Date();
  d.setHours(Math.floor(min / 60) % 24, min % 60, 0, 0);
  if (min >= 24 * 60) d.setDate(d.getDate() + 1);
  return d;
}

// ⚠️ findPath 는 "경로가 없음"과 "부르다 실패함"을 둘 다 null 로 돌려줍니다.
//    이분 탐색은 "없음"을 경계로 삼기 때문에, 한 번 실패하면 막차를 너무 이르게 잡습니다.
//    그래서 없다고 나오면 한 번 더 물어봅니다.
async function pathAt(from: string, to: string, min: number) {
  const off = min >= 24 * 60 ? 24 * 60 : 0;
  const first = await findPath(from, to, dateOf(min), "duration", off);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 150));
  return await findPath(from, to, dateOf(min), "duration", off);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  if (!from || !to) return Response.json({ error: "from 과 to 가 필요해요" }, { status: 400 });

  const now = new Date();
  let lo = now.getHours() * 60 + now.getMinutes();
  let hi = SEARCH_END;

  // 지금 당장도 못 가면 오늘은 끝난 것입니다
  const nowPath = await pathAt(from, to, lo);
  if (!nowPath) {
    return Response.json({ min: null, reason: "오늘은 이 방향 막차가 이미 끊겼어요" });
  }
  if (hi <= lo) return Response.json({ min: nowPath.legs[0].boardMin });

  // 경로가 있는 가장 늦은 시각을 찾습니다 (lo=있음, hi=없음 을 유지하며 좁힙니다)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await pathAt(from, to, mid);
    if (r) lo = mid;
    else hi = mid;
  }

  const last = await pathAt(from, to, lo);
  if (!last) return Response.json({ min: nowPath.legs[0].boardMin });

  return Response.json({
    min: last.legs[0].boardMin, // 막차 승차 시각 (1440을 넘으면 내일 새벽)
    arriveMin: last.legs[last.legs.length - 1].arriveMin,
    line: last.legs[0].line,
  });
}
