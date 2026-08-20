"use client";

// 열차 한 칸의 좌석 도식
//
// - 진행 방향은 언제나 위쪽입니다. 통로에 위쪽 화살표를 줄지어 놓아 방향을 알려줍니다.
// - 좌석은 실제 의자 모양으로 그립니다. 벽쪽에 등받이가 있고 통로를 향해 앉습니다.
// - 앉을 수 있는 좌석에는 번호를 붙이지 않습니다(누를 수 있다는 것만 보이면 됩니다).

import type { CarLayout, Seat } from "@/lib/car-layout";
import type { SeatState } from "@/lib/data";

type Props = {
  layout: CarLayout;
  seats: Record<string, SeatState>;
  pickedSeat: string | null;
  revealed: boolean;
  onTap: (seat: Seat) => void;
};

// 좌석 종류(교통약자석·임산부배려석)는 누가 앉아 있든 변하지 않으므로
// 점유 표시와 함께 계속 보여줍니다.
function seatClass(state: SeatState | undefined, seat: Seat, picked: boolean) {
  const base = ["cd-seat", seat.side];
  if (seat.kind === "priority") base.push("pri");
  else if (seat.kind === "pregnant") base.push("preg");
  if (state?.kind === "occupied") base.push("occ");
  if (picked) base.push("picked");
  return base.join(" ");
}

function SeatMark({ seat }: { seat: Seat }) {
  if (seat.kind === "priority") return <span className="cd-ic">♿</span>;
  if (seat.kind === "pregnant") return <span className="cd-ic">🤰</span>;
  return null; // 일반 빈 좌석은 번호 없이 모양만
}

function Side({ blocks, seats, pickedSeat, onTap }: {
  blocks: CarLayout["left"];
  seats: Record<string, SeatState>;
  pickedSeat: string | null;
  onTap: (seat: Seat) => void;
}) {
  return (
    <div className="cd-side">
      {blocks.map((block, bi) => (
        <div className="cd-blockwrap" key={bi}>
          <div className="cd-block">
            {block.seats.map((s) => {
              const st = seats[s.id];
              const free = !st || st.kind !== "occupied";
              return (
                <button
                  key={s.id}
                  className={seatClass(st, s, pickedSeat === s.id)}
                  onClick={() => free && onTap(s)}
                  disabled={!free}
                  aria-label={
                    s.kind === "priority" ? "교통약자석" : s.kind === "pregnant" ? "임산부배려석" : "좌석"
                  }
                >
                  <SeatMark seat={s} />
                  {st?.kind === "occupied" && <em className="cd-badge">{st.station}</em>}
                </button>
              );
            })}
          </div>
          {bi < blocks.length - 1 && (
            // 출입문: 위아래 문틀 사이에 양쪽으로 열린 문짝 두 짝
            <div className="cd-door" aria-hidden="true">
              <span className="cd-jamb" />
              <span className="cd-leaf" />
              <span className="cd-jamb" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function CarDiagram({ layout, seats, pickedSeat, revealed, onTap }: Props) {
  const taken = Object.values(seats).filter((s) => s.kind === "occupied").length;
  // 통로에 놓을 진행 방향 화살표 개수 (좌석 줄 길이에 맞춰)
  const arrows = Math.max(6, layout.left.reduce((a, b) => a + b.seats.length, 0) - 3);

  return (
    <div className="cd-wrap">
      {/* 범례를 위로 올려 좌석을 보기 전에 색을 먼저 익히게 합니다 */}
      <div className="cd-legend">
        <span><i className="cd-lg free" />앉을 수 있음</span>
        <span><i className="cd-lg occ" />하차정보 등록됨</span>
        <span><i className="cd-lg pri" />교통약자석</span>
        <span><i className="cd-lg preg" />임산부배려석</span>
      </div>

      <div className="cd-dir">
        <span className="cd-arrow" />
        열차 진행 방향
      </div>

      <div className={`cd-car${revealed ? " revealed" : ""}`}>
        <div className="cd-body">
          <Side blocks={layout.left} seats={seats} pickedSeat={pickedSeat} onTap={onTap} />
          <div className="cd-aisle" aria-hidden="true">
            {Array.from({ length: arrows }, (_, i) => (
              <span className="cd-up" key={i} />
            ))}
          </div>
          <Side blocks={layout.right} seats={seats} pickedSeat={pickedSeat} onTap={onTap} />
        </div>
      </div>

      <div className="cd-note">
        좌석 {layout.totalSeats}석 · 출입문 편측 {layout.doorsPerSide}개 · 등록 {taken}석
        {layout.approx && " · 대략적인 배치"}
        {layout.note ? ` · ${layout.note}` : ""}
      </div>
    </div>
  );
}
