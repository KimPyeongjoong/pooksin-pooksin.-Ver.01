// ============================================================
// 임시(목업) 데이터
// 실제 지하철 API(서울열린데이터광장 / ODsay) 연동 전까지
// 앱이 동작하도록 넣어둔 가짜 데이터입니다.
// 나중에 이 파일을 실제 API 호출로 교체하면 됩니다.
// ============================================================

// 좌석 상태 — 좌석의 "종류"(교통약자석 등)는 배치(car-layout.ts)가 정하고,
// 여기서는 비었는지 / 하차정보가 등록됐는지만 다룹니다.
export type SeatState =
  | { kind: "free" }
  | { kind: "occupied"; station: string; stopsLeft: number }; // station: 하차 예정역

// 좌석 점유 목업.
// 실제로는 사용자들이 등록한 하차정보(Supabase 예정)로 채워집니다.
// 지금은 좌석 id로부터 규칙적으로 만들어, 새로고침해도 같은 모습이 나오게 합니다.
// (무작위로 만들면 서버·브라우저 결과가 달라져 화면이 깜빡입니다.)
function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// seed에 칸 번호·노선을 넣어야 칸을 옮길 때 좌석 상황이 달라 보입니다.
// stations = 이 구간에서 앞으로 지나갈 역 목록 (승차역 다음부터 하차역까지)
export function makeMockSeats(
  ids: string[],
  seed = "",
  stations: string[] = []
): Record<string, SeatState> {
  const out: Record<string, SeatState> = {};
  if (!stations.length) return out;
  for (const id of ids) {
    const h = hash(seed + "|" + id);
    if (h % 100 < 28) {
      const i = h % stations.length;
      out[id] = { kind: "occupied", station: stations[i], stopsLeft: i + 1 };
    }
  }
  return out;
}

// 하차역 입력용 남은 역 목록 (신도림 방면, 갈산 이후)
export const REMAINING_STATIONS = [
  { name: "부평구청", line: "인천1호선" },
  { name: "부평시장", line: "인천1호선" },
  { name: "부평", line: "인천1호선" },
  { name: "동수", line: "인천1호선" },
  { name: "신중동", line: "7호선(환승)" },
  { name: "부천시청", line: "7호선" },
  { name: "상동", line: "7호선" },
];

// 역 클릭 시 표시할 기본 역 정보 (실시간 도착 카드는 API로 채움)
// 실제 데이터가 있는 서울 지역 역(강남)으로 데모합니다.
export const DEMO_STATION = {
  name: "강남",
  prev: "교대",
  next: "역삼",
};

// 실시간 응답이 비었을 때(샘플키 혼잡 등) 잠시 보여줄 예시 도착정보
export const MOCK_ARRIVALS = [
  { line: "2호선", dir: "성수행 - 역삼방면", trains: [{ msg: "4분 20초 후", sec: 260 }, { msg: "9분 후", sec: 540 }] },
  { line: "2호선", dir: "신도림행 - 교대방면", trains: [{ msg: "전역 도착", sec: 30 }, { msg: "7분 후", sec: 420 }] },
  { line: "신분당", dir: "신사행 - 신논현방면", trains: [{ msg: "2분 후", sec: 120 }] },
];

// 포인트 지갑 내역
export const LEDGER = [
  { type: "plus", title: "하차정보 등록 · 인천1호선", when: "오늘 8:19", delta: "+15" },
  { type: "plus", title: "정확도 보너스 · 실제 하차 확인", when: "오늘 8:41", delta: "+30" },
  { type: "minus", title: "하차예정지 확인 · 3번 칸", when: "어제 18:02", delta: "−1" },
  { type: "minus", title: "허위정보 신고 확정 · 패널티", when: "3일 전", delta: "−50" },
] as const;
