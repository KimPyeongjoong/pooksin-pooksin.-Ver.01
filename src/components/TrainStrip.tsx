"use client";

// "내가 탄 열차" 고르기 (탑승 칸 선택 화면 최상단)
//
// 실시간 열차 위치 화면을 가로로 눕힌 모양입니다.
// 노선을 가로 직선으로 그리고 그 위에 지금 달리는 열차를 올려둡니다.
// 열차를 누르면 내가 탄 열차가 바뀌고, 선택된 열차가 화면 가운데로 옵니다.
//
// 데이터: /api/positions (서울열린데이터광장 실시간 열차 위치)
//        서울교통공사 운영 노선만 제공되므로, 없는 노선은 시간표 기준 안내로 대체합니다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lineStations } from "@/lib/lines";
import { lineColor } from "@/lib/line-colors";

export type TrainPos = {
  trainNo: string;
  station: string;
  dest: string;
  updn: "up" | "down";
  status: string;
  express: boolean;
  last: boolean;
};

type Res = { supported?: boolean; reason?: string; updatedAt?: string; trains?: TrainPos[] };

type Props = {
  line: string;
  boardStation: string; // 타는 역
  endStation?: string; // 내리는 역 (진행 방향을 정하는 데 씁니다)
  wayCode?: number | null; // 1=상행/외선, 2=하행/내선
  fallbackLabel?: string | null; // 실시간이 없을 때 보여줄 시간표 기준 열차
  selected: TrainPos | null;
  onSelect: (t: TrainPos | null) => void;
};

// 보여줄 구간: 타는 역 기준 앞뒤 몇 개 역까지
// (좌우로 넉넉히 움직이며 다른 열차를 찾아 고를 수 있도록 넓게 잡습니다)
const BEFORE = 20;
const AFTER = 12;

export default function TrainStrip({
  line,
  boardStation,
  endStation,
  wayCode,
  fallbackLabel,
  selected,
  onSelect,
}: Props) {
  const [res, setRes] = useState<Res | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pickedOnce = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/positions?line=${encodeURIComponent(line)}`)
      .then((r) => r.json())
      .then((d: Res) => setRes(d))
      .catch(() => setRes({ supported: false, reason: "네트워크 오류", trains: [] }))
      .finally(() => setLoading(false));
  }, [line]);

  useEffect(() => {
    pickedOnce.current = false;
    load();
    const id = window.setInterval(load, 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  // 진행 방향이 왼쪽 → 오른쪽이 되도록 역 순서를 맞춥니다.
  const stations = useMemo(() => {
    const all = lineStations(line);
    if (!all.length) return [];
    const s = all.indexOf(boardStation);
    const e = endStation ? all.indexOf(endStation) : -1;
    return s >= 0 && e >= 0 && e < s ? [...all].reverse() : all;
  }, [line, boardStation, endStation]);

  const boardIdx = stations.indexOf(boardStation);

  // 이 구간과 같은 방향으로 가는 열차만 (반대 방향을 고르면 엉뚱한 열차가 되므로 엄격히)
  //
  // 경로검색으로 들어온 경우엔 상·하행 코드(wayCode)가 있습니다.
  // "지금 열차 안이에요"로 들어온 경우엔 코드가 없으므로, 열차의 종착역이
  // 현재 위치보다 진행 방향 쪽에 있는지를 보고 같은 방향인지 판단합니다.
  const want = wayCode === 2 ? "down" : "up";
  const trains = useMemo(() => {
    const all = res?.trains ?? [];
    if (wayCode === 1 || wayCode === 2) return all.filter((t) => t.updn === want);
    if (!stations.length) return all;
    return all.filter((t) => {
      const here = stations.indexOf(t.station);
      const to = stations.indexOf(t.dest);
      return here >= 0 && to >= 0 ? to > here : true;
    });
  }, [res, want, wayCode, stations]);
  const otherWayCount = (res?.trains ?? []).length - trains.length;

  // 보여줄 역 구간
  const from = boardIdx >= 0 ? Math.max(0, boardIdx - BEFORE) : 0;
  const to = boardIdx >= 0 ? Math.min(stations.length, boardIdx + AFTER + 1) : stations.length;
  const window_ = stations.slice(from, to);

  const trainsAt = useMemo(() => {
    const m = new Map<string, TrainPos[]>();
    for (const t of trains) {
      if (!m.has(t.station)) m.set(t.station, []);
      m.get(t.station)!.push(t);
    }
    return m;
  }, [trains]);

  // 갱신될 때마다 내가 고른 열차의 최신 위치를 반영합니다(같은 열차번호로 다시 찾기).
  useEffect(() => {
    if (!selected) return;
    const fresh = trains.find((t) => t.trainNo === selected.trainNo);
    if (fresh && (fresh.station !== selected.station || fresh.status !== selected.status)) {
      onSelect(fresh);
    }
  }, [trains, selected, onSelect]);

  // 처음 열 때, 타는 역에 가장 가까운 열차를 자동으로 골라줍니다.
  useEffect(() => {
    if (pickedOnce.current || boardIdx < 0 || !trains.length) return;
    let best: TrainPos | null = null;
    let bestGap = Infinity;
    for (const t of trains) {
      const i = stations.indexOf(t.station);
      if (i < 0) continue;
      const gap = Math.abs(i - boardIdx);
      if (gap < bestGap) {
        bestGap = gap;
        best = t;
      }
    }
    if (best) {
      pickedOnce.current = true;
      onSelect(best);
    }
  }, [trains, stations, boardIdx, onSelect]);

  // 선택된 열차(없으면 타는 역)를 가운데로.
  // 20초마다 갱신될 때마다 가운데로 되돌리면 사용자가 좌우로 둘러볼 수 없으므로,
  // "고른 열차가 바뀌었을 때"만 움직입니다.
  const centeredOn = useRef<string | null>(null);
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || !window_.length) return;
    const key = selected?.trainNo ?? "__board__";
    if (centeredOn.current === key) return;
    const target =
      box.querySelector<HTMLElement>(".ts-col.has-sel") ?? box.querySelector<HTMLElement>(".ts-col.board");
    if (!target) return;
    centeredOn.current = key;
    // 애니메이션 없이 바로 가운데로 (열자마자 가운데에 있어야 하므로)
    box.scrollLeft = target.offsetLeft - box.clientWidth / 2 + target.clientWidth / 2;
  }, [selected, window_.length]);

  // 마우스로도 좌우로 끌어서 볼 수 있게 (휴대폰은 손가락으로 그냥 넘어갑니다)
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let down = false;
    let startX = 0;
    let startLeft = 0;
    let moved = 0;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      down = true;
      moved = 0;
      startX = e.clientX;
      startLeft = box.scrollLeft;
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      box.scrollLeft = startLeft - dx;
      if (moved > 4) e.preventDefault();
    };
    const onUp = () => {
      down = false;
    };
    // 끌고 나서 손을 뗄 때 열차가 눌리지 않도록
    const onClick = (e: MouseEvent) => {
      if (moved > 4) {
        e.stopPropagation();
        e.preventDefault();
        moved = 0;
      }
    };
    box.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    box.addEventListener("click", onClick, true);
    return () => {
      box.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      box.removeEventListener("click", onClick, true);
    };
  }, []);

  const color = lineColor(line);
  const unsupported = res && res.supported === false;
  const empty = res?.supported && trains.length === 0;

  return (
    <div className="ts">
      <div className="ts-head">
        <b>내가 탄 열차</b>
        {selected ? (
          <span className="ts-sel">
            {selected.dest}행 · {selected.station} {selected.status}
            {selected.express && <em className="lt-tag exp">급행</em>}
            {selected.last && <em className="lt-tag last">막차</em>}
          </span>
        ) : (
          <span className="ts-sel dim">{fallbackLabel || "선택 안 됨"}</span>
        )}
        <button className="ts-refresh" onClick={load} aria-label="새로고침">
          ↻
        </button>
      </div>

      {(unsupported || empty || stations.length === 0) && (
        <div className="ts-note">
          {stations.length === 0
            ? "이 노선의 역 순서 정보가 없어요"
            : unsupported
              ? "이 노선은 실시간 열차 위치가 공개되지 않아요"
              : otherWayCount > 0
                ? `이 방향으로 가는 열차가 지금 없어요 (반대 방향 ${otherWayCount}대 운행 중)`
                : "지금 운행 중인 열차가 없어요 (막차 이후)"}
          {fallbackLabel ? ` · 시간표 기준 ${fallbackLabel}` : ""}
        </div>
      )}

      {stations.length > 0 && (
        <div className="ts-scroll" ref={scrollRef}>
          <div className="ts-inner">
            <span className="ts-rail" style={{ background: color }} />
            {window_.map((name) => {
              const here = trainsAt.get(name) ?? [];
              const isBoard = name === boardStation;
              const hasSel = !!selected && here.some((t) => t.trainNo === selected.trainNo);
              return (
                <div className={`ts-col${isBoard ? " board" : ""}${hasSel ? " has-sel" : ""}`} key={name}>
                  <div className="ts-trains">
                    {here.map((t) => {
                      const on = selected?.trainNo === t.trainNo;
                      return (
                        <button
                          className={`ts-train${on ? " on" : ""}`}
                          key={t.trainNo}
                          onClick={() => onSelect(t)}
                          style={on ? { background: color, borderColor: color } : { borderColor: color }}
                        >
                          <b>{t.dest}</b>
                          <small>{t.status}</small>
                        </button>
                      );
                    })}
                  </div>
                  <span
                    className={`ts-dot${isBoard ? " board" : ""}`}
                    style={isBoard ? { background: color, borderColor: color } : { borderColor: color }}
                  />
                  <span className="ts-name">{name}</span>
                  {isBoard && <span className="ts-tagme">승차</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="ts-foot">
        <span>← 지나온 역</span>
        <span>{res?.updatedAt ? `${res.updatedAt} 기준 · 20초마다 갱신` : loading ? "불러오는 중…" : ""}</span>
        <span>진행 방향 →</span>
      </div>
    </div>
  );
}
