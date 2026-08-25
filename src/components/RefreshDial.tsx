"use client";

// 새로고침 버튼 — 회전 화살표 안에 "자동 새로고침까지 남은 초"가 줄어듭니다.
//
// 화면마다 자동으로 다시 불러오는 주기가 있는데, 그게 언제인지 안 보이면
// 사용자는 화면이 멈춘 건지 살아 있는 건지 알 수 없습니다. 그래서 숫자를 같이 보여줍니다.
// 눌러서 바로 새로고침할 수도 있고, 그러면 숫자도 처음으로 돌아갑니다.
//
//   floating: 화면 오른쪽 아래에 떠 있는 동그란 단추 (상세경로·좌석 화면)
//   그 외    : 줄 안에 들어가는 작은 단추 (열차 선택 줄)

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageVisible, useOnReturn } from "@/lib/visible";

export default function RefreshDial({
  every = 20,
  onRefresh,
  floating = false,
  paused = false,
  title = "새로고침",
}: {
  every?: number; // 자동 새로고침 주기(초)
  onRefresh: () => void;
  floating?: boolean;
  paused?: boolean; // 자동 새로고침을 멈춤 (예: 오늘 조회 한도를 다 썼을 때)
  title?: string;
}) {
  const [left, setLeft] = useState(every);
  // 다른 탭으로 옮기거나 폰 화면이 꺼지면 초읽기를 멈춥니다.
  // (안 보는 화면 때문에 실시간 조회 한도가 새어 나가는 걸 막습니다)
  const visible = usePageVisible();
  const stopped = paused || !visible;
  // 최신 콜백을 담아둡니다 (타이머를 매번 다시 걸지 않으려고)
  const cb = useRef(onRefresh);
  useEffect(() => {
    cb.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    // 멈춤 상태에선 세지 않습니다 (안 보고 있거나, 불러봐야 같은 오류일 때)
    if (stopped) return;
    const id = window.setInterval(() => {
      setLeft((v) => {
        if (v <= 1) {
          cb.current();
          return every;
        }
        return v - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [every, stopped]);

  // 화면으로 돌아오면 그 즉시 한 번 새로 받고 초읽기를 처음으로 되돌립니다
  const onReturn = useCallback(() => {
    if (paused) return;
    cb.current();
    setLeft(every);
  }, [paused, every]);
  useOnReturn(onReturn);

  return (
    <button
      className={`rfd${floating ? " float" : ""}`}
      title={title}
      aria-label={stopped ? title : `${title} (자동 ${left}초 뒤)`}
      onClick={() => {
        cb.current();
        setLeft(every);
      }}
    >
      {/* 회전 화살표 — 위(12시)에서 시계방향으로 한 바퀴 조금 못 미치게 돌고,
          호가 "끝나는" 왼쪽 위 지점에 진행 방향(오른쪽 위)으로 화살촉을 답니다 */}
      <svg className="rfd-ic" viewBox="0 0 40 40" aria-hidden="true">
        <path
          d="M20 5.5 a14.5 14.5 0 1 1 -10.3 4.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <polygon points="13.2,6.3 11.1,14.0 5.5,8.4" fill="currentColor" />
      </svg>
      {!stopped && <b className="rfd-num">{left}</b>}
    </button>
  );
}
