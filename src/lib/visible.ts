"use client";

// 화면을 지금 보고 있는지 알려줍니다.
//
// ⚠️ 왜 필요한가
//    앱을 켜둔 채 다른 탭으로 옮기거나 폰 화면을 꺼도 20초 타이머는 계속 돕니다.
//    그동안 나가는 실시간 조회는 아무도 안 보는 화면을 위한 것인데,
//    서울시 실시간 API는 하루 1,000건 한도라 "켜두고 잊은 시간"만으로 한도가 찹니다.
//    (상세경로보기 화면은 지하철 구간 하나당 2건씩 나가서, 환승 2회 경로면 시간당 1,080건입니다)
//
//    그래서 안 보고 있을 땐 멈추고, 돌아오면 그 즉시 한 번 새로 받습니다.

import { useEffect, useState } from "react";

export function usePageVisible(): boolean {
  // 서버에서는 보이는 상태로 둡니다 (첫 그림이 멈춘 것처럼 보이지 않도록)
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

// 숨겨졌다가 **다시 보이게 된 순간**에만 부릅니다.
// (처음 열 때는 부르지 않습니다 — 그건 각 화면이 알아서 하는 첫 불러오기와 겹칩니다)
export function useOnReturn(fn: () => void): void {
  useEffect(() => {
    let wasHidden = document.visibilityState !== "visible";
    const on = () => {
      if (document.visibilityState === "visible") {
        if (wasHidden) fn();
        wasHidden = false;
      } else {
        wasHidden = true;
      }
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [fn]);
}
