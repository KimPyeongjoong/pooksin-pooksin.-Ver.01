// 실시간 열차 위치 서버 경로 (서울열린데이터광장 realtimePosition)
//
// 호출 예: /api/positions?line=2호선
//
// 지금 그 노선 위를 달리는 열차가 "어느 역에" 있는지 알려줍니다.
// 서울교통공사가 운영하는 노선만 제공됩니다(인천1호선 등은 데이터 없음).
//
// 실제로 부르고 정리하는 일은 src/lib/live.ts 가 합니다.
// (같은 자료를 /api/next-trains 도 쓰기 때문에, 방향 뒤집기 같은 규칙이 갈라지지 않도록 한곳에 모았습니다)

import { fetchPositions } from "@/lib/live";

export type { TrainPos } from "@/lib/live";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("line") ?? "";
  if (!raw) return Response.json({ error: "line 필요", trains: [] }, { status: 400 });

  const pos = await fetchPositions(raw);
  return Response.json({
    line: pos.line,
    supported: pos.supported,
    reason: pos.reason,
    updatedAt: pos.updatedAt,
    count: pos.trains.length,
    trains: pos.trains,
  });
}
