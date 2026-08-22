"use client";

// 역 전체 시간표 화면
//
// 평일 / 토요일 / 공휴일 탭을 누르면 그에 맞는 시간표가 나옵니다.
// 오늘이 어느 쪽인지는 서버가 공휴일까지 따져서 정해줍니다(대체공휴일 포함).
// 시간대 칩(05시, 06시 …)을 누르면 그 시간대만 보여줍니다.

import { useEffect, useMemo, useRef, useState } from "react";
import { DAY_LABEL, type DayType } from "@/lib/holidays";

type Departure = { min: number; dest: string };
type Dirs = { up: Departure[]; down: Departure[] };

type TimetableRes = {
  stationName?: string;
  line?: string;
  color?: string;
  upWay?: string;
  downWay?: string;
  today?: DayType;
  isHoliday?: boolean;
  holidayDataStale?: boolean;
  lists?: Record<DayType, Dirs>;
  siblings?: { stationID: number; line: string }[];
  error?: string;
};

type Props = {
  station: string;
  line?: string | null; // 처음에 열 노선 (없으면 첫 번째 노선)
  initialWay?: "up" | "down" | null; // 도착정보에서 방면을 눌러 들어온 경우
  nowMin: number;
  onClose: () => void;
};

const DAYS: DayType[] = ["weekday", "sat", "sun"];

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export default function TimetableView({ station, line, initialWay, nowMin, onClose }: Props) {
  const [data, setData] = useState<TimetableRes | null>(null);
  const [loading, setLoading] = useState(true);
  const [curLine, setCurLine] = useState<string | null>(line ?? null);
  const [day, setDay] = useState<DayType | null>(null);
  const [hour, setHour] = useState<number | null>(null);
  const hourBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLoading(true);
    setData(null);
    const q = new URLSearchParams({ station });
    if (curLine) q.set("line", curLine);
    fetch(`/api/timetable?${q}`)
      .then((r) => r.json())
      .then((d: TimetableRes) => {
        setData(d);
        // 처음 열 때만 오늘 요일로 맞춥니다(사용자가 탭을 바꾼 뒤엔 유지).
        setDay((prev) => prev ?? d.today ?? "weekday");
        if (!curLine && d.line) setCurLine(d.line);
      })
      .catch(() => setData({ error: "시간표를 불러오지 못했어요" }))
      .finally(() => setLoading(false));
  }, [station, curLine]);

  const dirs: Dirs | null = data?.lists && day ? data.lists[day] : null;

  // 시간표에 실제로 존재하는 시간대만 칩으로 만듭니다.
  const hours = useMemo(() => {
    if (!dirs) return [];
    const set = new Set<number>();
    for (const d of [...dirs.up, ...dirs.down]) set.add(Math.floor(d.min / 60));
    return [...set].sort((a, b) => a - b);
  }, [dirs]);

  // 지금 시간대를 기본으로 선택 (없으면 첫 시간대)
  useEffect(() => {
    if (!hours.length) return;
    setHour((prev) => {
      if (prev != null && hours.includes(prev)) return prev;
      const nowH = Math.floor(nowMin / 60);
      return hours.includes(nowH) ? nowH : hours[0];
    });
  }, [hours, nowMin]);

  // 선택된 시간대 칩이 보이도록 가로 스크롤
  useEffect(() => {
    const bar = hourBarRef.current;
    if (!bar) return;
    const on = bar.querySelector<HTMLElement>(".hchip.on");
    if (on) bar.scrollTo({ left: on.offsetLeft - bar.clientWidth / 2 + on.clientWidth / 2 });
  }, [hour, day]);

  const lastOf = (list: Departure[]) => (list.length ? list[list.length - 1].min : null);
  const firstOf = (list: Departure[]) => (list.length ? list[0].min : null);

  function column(list: Departure[], wayLabel: string) {
    const rows = hour == null ? list : list.filter((d) => Math.floor(d.min / 60) === hour);
    const last = lastOf(list);
    const first = firstOf(list);
    // 오늘 기준 "다음 열차" 강조는 오늘 요일 탭을 보고 있을 때만
    const isToday = day === data?.today;
    const nextMin = isToday ? list.find((d) => d.min >= nowMin)?.min ?? null : null;
    return (
      <div className="tt-col">
        <div className="tt-colhead">
          <b>{wayLabel || "—"} 방면</b>
        </div>
        {rows.length === 0 ? (
          <div className="tt-empty">이 시간대에는 열차가 없어요</div>
        ) : (
          rows.map((d, i) => (
            // 같은 시각·같은 행선지가 두 번 나올 수 있어 순번을 키에 함께 씁니다
            <div
              className={`tt-row${d.min === nextMin ? " next" : ""}`}
              key={`${d.min}-${d.dest}-${i}`}
            >
              <span className="tt-time">
                {hhmm(d.min)}
                {d.min === last && <em className="tt-badge last">막</em>}
                {d.min === first && <em className="tt-badge first">첫</em>}
              </span>
              {d.dest && <span className="tt-dest">{d.dest}행</span>}
            </div>
          ))
        )}
      </div>
    );
  }

  const lines = data?.siblings ?? [];

  return (
    <div className="tt-wrap">
      <div className="tt-head">
        <div className="tt-title">
          <b>{station}역</b>
          <span style={{ color: data?.color ?? "var(--faint)" }}>{data?.line ?? curLine ?? ""}</span>
        </div>
        <button className="tt-close" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>

      {/* 이 역에 노선이 여러 개면 고를 수 있게 */}
      {lines.length > 1 && (
        <div className="tt-lines">
          {lines.map((s) => (
            <button
              key={s.line}
              className={`lchip${s.line === (data?.line ?? curLine) ? " on" : ""}`}
              onClick={() => {
                setHour(null);
                setCurLine(s.line);
              }}
            >
              {s.line}
            </button>
          ))}
        </div>
      )}

      <div className="tt-days">
        {DAYS.map((d) => (
          <button key={d} className={`dchip${day === d ? " on" : ""}`} onClick={() => setDay(d)}>
            {DAY_LABEL[d]}
            {d === data?.today && <span className="dot" />}
          </button>
        ))}
      </div>

      {data?.today === "sun" && data?.isHoliday && (
        <div className="tt-note">오늘은 공휴일이라 휴일 시간표로 운행합니다</div>
      )}
      {data?.holidayDataStale && (
        <div className="tt-note warn">공휴일 목록이 오래됐어요 · 탭으로 직접 골라주세요</div>
      )}

      {loading && <div className="tt-loading">시간표 불러오는 중…</div>}
      {!loading && data?.error && <div className="tt-loading">{data.error}</div>}

      {!loading && dirs && (
        <>
          <div className="tt-hours" ref={hourBarRef}>
            <button className={`hchip${hour == null ? " on" : ""}`} onClick={() => setHour(null)}>
              전체
            </button>
            {hours.map((h) => (
              <button key={h} className={`hchip${hour === h ? " on" : ""}`} onClick={() => setHour(h)}>
                {h % 24}시
              </button>
            ))}
          </div>

          {/* 도착정보에서 누른 방향을 왼쪽(먼저 보이는 자리)에 둡니다 */}
          <div className="tt-cols">
            {(initialWay === "down"
              ? ([
                  [dirs.down, data?.downWay ?? "하행"],
                  [dirs.up, data?.upWay ?? "상행"],
                ] as const)
              : ([
                  [dirs.up, data?.upWay ?? "상행"],
                  [dirs.down, data?.downWay ?? "하행"],
                ] as const)
            ).map(([list, label], i) => (
              // 2호선처럼 양방향 방면 이름이 같을 수 있어(둘 다 "성수 방면") 순서를 키에 넣습니다.
              <div key={i}>{column(list, label)}</div>
            ))}
          </div>

          <div className="tt-foot">
            출처: ODsay 지하철 시간표 · {DAY_LABEL[day ?? "weekday"]} 기준
            {data?.line ? ` · ${data.line}` : ""}
          </div>
        </>
      )}
    </div>
  );
}
