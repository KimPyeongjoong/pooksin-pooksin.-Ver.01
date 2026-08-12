// ============================================================
// 임시(목업) 데이터
// 실제 지하철 API(서울열린데이터광장 / ODsay) 연동 전까지
// 앱이 동작하도록 넣어둔 가짜 데이터입니다.
// 나중에 이 파일을 실제 API 호출로 교체하면 됩니다.
// ============================================================

export type SeatState =
  | { kind: "free" }
  | { kind: "priority" }
  | { kind: "occupied"; stopsLeft: number }; // stopsLeft: 하차까지 남은 역 수

// 3번 칸 좌석 배치 (윗줄/아랫줄, 각 14석)
// 실제로는 열차 형식마다 다르지만 MVP에선 고정 배치를 씁니다.
export const CAR_SEATS: { top: SeatState[]; bottom: SeatState[] } = {
  top: [
    { kind: "free" },
    { kind: "occupied", stopsLeft: 2 },
    { kind: "free" },
    { kind: "free" },
    { kind: "occupied", stopsLeft: 1 },
    { kind: "free" },
    { kind: "priority" },
    { kind: "priority" },
    { kind: "free" },
    { kind: "occupied", stopsLeft: 4 },
    { kind: "free" },
    { kind: "free" },
    { kind: "free" },
    { kind: "priority" },
  ],
  bottom: [
    { kind: "priority" },
    { kind: "free" },
    { kind: "occupied", stopsLeft: 1 },
    { kind: "free" },
    { kind: "free" },
    { kind: "priority" },
    { kind: "priority" },
    { kind: "free" },
    { kind: "free" },
    { kind: "occupied", stopsLeft: 3 },
    { kind: "free" },
    { kind: "occupied", stopsLeft: 2 },
    { kind: "free" },
    { kind: "priority" },
  ],
};

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
