"use client";

// 출발 시각 설정 — 다이얼(휠) 시트
//
// 경로검색 화면에서 시각 옆의 ⌄ 를 누르면 아래에서 올라옵니다.
// 날짜 · 오전/오후 · 시 · 분 네 개의 다이얼을 굴려 고르고 [확인]을 누르면 그 시각으로 경로를 다시 찾습니다.
//
// 라이브러리 없이 만듭니다: 세로 스크롤 + `scroll-snap`으로 칸이 가운데에 딱 멈추게 하고,
// 멈춘 위치(스크롤 값 ÷ 칸 높이)로 고른 값을 읽습니다.
//
// 첫차·막차는 그 역 시간표의 처음/마지막 열차 시각을 그대로 넣습니다.
// (도착 시각으로 거꾸로 찾는 기능은 넣지 않았습니다 — 지금 쓰는 공공 경로검색 API가
//  "이 시각 이후 출발"만 받기 때문에, 흉내만 내면 틀린 값을 보여주게 됩니다)

import { useEffect, useRef, useState } from "react";

const ITEM_H = 38; // 다이얼 한 칸 높이(px) — CSS 와 맞춰야 합니다
const VISIBLE = 5; // 보이는 칸 수 (가운데가 선택)

type Tab = "depart" | "first" | "last";

function Wheel({
  items,
  value,
  onChange,
  width,
  dim,
}: {
  items: string[];
  value: number; // 고른 칸 번호
  onChange: (i: number) => void;
  width?: number;
  dim?: boolean; // 흐리게 (첫차·막차를 고르면 다이얼을 못 쓰게)
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const settle = useRef<number | null>(null);
  // 사용자가 굴리는 중인지. 굴리는 동안에는 코드가 스크롤을 건드리지 않습니다
  // (건드리면 손가락으로 굴리던 게 튕겨 나갑니다)
  const rolling = useRef(false);

  // 밖에서 값이 바뀌었을 때만 그 칸으로 맞춰줍니다
  useEffect(() => {
    const el = ref.current;
    if (!el || rolling.current) return;
    const top = value * ITEM_H;
    if (Math.abs(el.scrollTop - top) < 2) return;
    el.scrollTo({ top });
  }, [value]);

  return (
    <div
      className={`dial-col${dim ? " dim" : ""}`}
      style={width ? { width } : undefined}
      ref={ref}
      onScroll={() => {
        const el = ref.current;
        if (!el) return;
        rolling.current = true;
        // 굴리는 즉시 가운데 칸을 읽어 반영합니다 (하이라이트가 손가락을 따라오도록)
        const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / ITEM_H)));
        if (i !== value) onChange(i);
        // 잠시 멈추면 "다 굴렸다"고 봅니다
        if (settle.current) window.clearTimeout(settle.current);
        settle.current = window.setTimeout(() => {
          rolling.current = false;
        }, 250);
      }}
    >
      {/* 첫 칸과 마지막 칸도 가운데에 올 수 있도록 위아래를 비워둡니다 */}
      <div style={{ height: ITEM_H * Math.floor(VISIBLE / 2) }} />
      {items.map((t, i) => (
        <div key={i} className={`dial-item${i === value ? " on" : ""}`}>
          {t}
        </div>
      ))}
      <div style={{ height: ITEM_H * Math.floor(VISIBLE / 2) }} />
    </div>
  );
}

export default function TimeDial({
  initialMin,
  nowMin,
  firstMin,
  lastMin,
  onPick,
  onClose,
}: {
  initialMin: number; // 지금 고쳐져 있는 시각 (자정 기준 분, 1440 넘으면 내일)
  nowMin: number;
  firstMin: number | null; // 이 역 첫차
  lastMin: number | null; // 이 역 막차
  onPick: (min: number | null) => void; // null = 지금 출발
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("depart");
  const [day, setDay] = useState(initialMin >= 1440 ? 1 : 0);
  const base = initialMin % 1440;
  const [ampm, setAmpm] = useState(base >= 720 ? 1 : 0);
  const [hour, setHour] = useState(((Math.floor(base / 60) + 11) % 12)); // 0=1시 … 11=12시
  const [minute, setMinute] = useState(base % 60);

  const DAYS = ["오늘", "내일"];
  const AMPM = ["오전", "오후"];
  const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

  // 다이얼에서 고른 값 → 자정 기준 분
  const picked = (() => {
    const h12 = hour + 1;
    const h24 = ampm === 1 ? (h12 % 12) + 12 : h12 % 12;
    return day * 1440 + h24 * 60 + minute;
  })();

  const confirm = () => {
    if (tab === "first" && firstMin != null) return onPick(firstMin);
    if (tab === "last" && lastMin != null) return onPick(lastMin);
    onPick(picked);
  };

  const hhmm = (m: number) =>
    `${m >= 1440 ? "내일 " : ""}${m % 1440 < 720 ? "오전" : "오후"} ` +
    `${(Math.floor((m % 1440) / 60) + 11) % 12 + 1}:${String(m % 60).padStart(2, "0")}`;

  return (
    <div className="dial-back" onClick={onClose}>
      <div className="dial-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="dial-head">
          <b>출발 시각 설정</b>
          <button onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="dial-tabs">
          <button className={tab === "depart" ? "on" : ""} onClick={() => setTab("depart")}>
            출발 시각
          </button>
          <button
            className={tab === "first" ? "on" : ""}
            disabled={firstMin == null}
            onClick={() => setTab("first")}
          >
            첫차
          </button>
          <button
            className={tab === "last" ? "on" : ""}
            disabled={lastMin == null}
            onClick={() => setTab("last")}
          >
            막차
          </button>
        </div>

        {tab === "depart" ? (
          <div className="dial-wrap">
            <div className="dial-band" />
            <Wheel items={DAYS} value={day} onChange={setDay} width={92} />
            <Wheel items={AMPM} value={ampm} onChange={setAmpm} width={64} />
            <Wheel items={HOURS} value={hour} onChange={setHour} width={54} />
            <span className="dial-colon">:</span>
            <Wheel items={MINUTES} value={minute} onChange={setMinute} width={54} />
          </div>
        ) : (
          <div className="dial-note">
            {tab === "first"
              ? `이 역 첫차는 ${firstMin != null ? hhmm(firstMin) : "-"} 입니다`
              : `이 역 막차는 ${lastMin != null ? hhmm(lastMin) : "-"} 입니다`}
          </div>
        )}

        <div className="dial-btns">
          <button className="ghost" onClick={() => onPick(null)}>
            지금 출발
            <small>{hhmm(nowMin)}</small>
          </button>
          <button className="go" onClick={confirm}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}
