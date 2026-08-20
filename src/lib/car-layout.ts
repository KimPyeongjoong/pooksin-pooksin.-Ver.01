// 열차 한 칸의 실제 좌석 배치
//
// 수도권 중전철(1~9호선, 경의중앙, 수인분당, 신분당, 공항철도, 인천1호선 등)의
// 표준 배치는 아래와 같습니다. 한쪽 벽면 기준으로:
//
//   [교통약자석 3] ▯문▯ [일반석 7] ▯문▯ [일반석 7] ▯문▯ [일반석 7] ▯문▯ [교통약자석 3]
//
// → 한쪽 27석 × 양쪽 = 54석, 편측 출입문 4개.
//   일반석(7인석) 6개 + 교통약자석(3인석) 4개 = 서울시 자료와 일치합니다.
//   최신 차량은 일반석이 6인석이라 48석인 경우도 있습니다(아래 GENERAL_SEATS 참고).
//
// 임산부배려석은 1~8호선 기준 한 칸에 2석입니다(양쪽 벽면에 1석씩).
// ⚠️ 정확히 몇 번째 자리인지는 공개 자료가 없어 객실 가운데 자리로 표시합니다.

export type SeatKind = "general" | "priority" | "pregnant";

export type Seat = {
  id: string; // 좌석 구분용 (예: "L2-3")
  kind: SeatKind;
  side: "left" | "right";
};

export type Block = { seats: Seat[] };

export type CarLayout = {
  kind: "heavy" | "light";
  left: Block[]; // 진행 방향 기준 왼쪽 벽면 (블록 사이가 출입문)
  right: Block[];
  doorsPerSide: number;
  totalSeats: number;
  approx: boolean; // 실제와 다를 수 있는 대략적인 배치인지
  note?: string;
};

// 중전철 한쪽 벽면 구성 (숫자는 좌석 수, 0은 출입문 자리)
const HEAVY_SIDE = [3, 7, 7, 7, 3]; // 교통약자석 3 / 일반석 7 × 3 / 교통약자석 3
// 경전철은 차량이 작아 좌석이 훨씬 적습니다. ⚠️ 노선별 실제 배치 자료가 없어 대략치입니다.
const LIGHT_SIDE = [3, 5, 3];

function buildSide(counts: number[], side: "left" | "right"): Block[] {
  // 가운데 블록의 가운데 자리를 임산부배려석으로 둡니다 (한쪽에 1석 → 한 칸에 2석)
  const midBlock = Math.floor(counts.length / 2);
  return counts.map((n, b) => ({
    seats: Array.from({ length: n }, (_, i) => {
      const isEndBlock = b === 0 || b === counts.length - 1;
      const isPregnant = b === midBlock && i === Math.floor(n / 2);
      const kind: SeatKind = isEndBlock ? "priority" : isPregnant ? "pregnant" : "general";
      return { id: `${side === "left" ? "L" : "R"}${b}-${i}`, kind, side };
    }),
  }));
}

// 이 노선의 한 칸이 어떻게 생겼는지
export function carLayout(line: string, cars: number): CarLayout {
  // 칸이 3량 이하면 경전철로 봅니다 (인천2호선·우이신설·신림·김포골드·의정부·용인)
  const light = cars <= 3;
  const counts = light ? LIGHT_SIDE : HEAVY_SIDE;
  const left = buildSide(counts, "left");
  const right = buildSide(counts, "right");
  const perSide = counts.reduce((a, b) => a + b, 0);

  return {
    kind: light ? "light" : "heavy",
    left,
    right,
    doorsPerSide: counts.length - 1,
    totalSeats: perSide * 2,
    approx: light,
    note: light
      ? "경전철은 차량마다 좌석 배치가 달라 대략적인 모습입니다"
      : /^[47]호선$/.test(line)
        ? "이 노선 일부 편성에는 의자 없는 칸이 있습니다"
        : undefined,
  };
}

// 좌석 전체를 한 줄로 (상태 저장·집계용)
export function allSeats(layout: CarLayout): Seat[] {
  return [...layout.left, ...layout.right].flatMap((b) => b.seats);
}
