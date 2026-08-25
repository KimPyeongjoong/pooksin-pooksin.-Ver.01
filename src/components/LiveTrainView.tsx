"use client";

// 실시간 열차 위치 화면
//
// 노선을 일직선으로 펴서 역을 세로로 늘어놓고, 지금 그 역에 있는 열차를 옆에 표시합니다.
// 데이터: 서울열린데이터광장 realtimePosition (서울교통공사 운영 노선만 제공)
// 역 순서: 앱에 내장한 노선도(linemap)에서 가져옵니다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lineStations, linesAtStation } from "@/lib/lines";
import { lineColor } from "@/lib/line-colors";

type TrainPos = {
  trainNo: string;
  station: string;
  dest: string;
  updn: "up" | "down";
  status: string;
  express: boolean;
  last: boolean;
};

type Res = {
  line?: string;
  supported?: boolean;
  reason?: string;
  updatedAt?: string;
  trains?: TrainPos[];
};

type Props = {
  station: string;
  line?: string | null;
  onClose: () => void;
  onStationClick?: (name: string) => void;
};

export default function LiveTrainView({ station, line, onClose, onStationClick }: Props) {
  const available = useMemo(() => linesAtStation(station), [station]);
  const [curLine, setCurLine] = useState<string>(line ?? available[0]?.label ?? "");
  const [dir, setDir] = useState<"up" | "down">("up");
  const [res, setRes] = useState<Res | null>(null);
  const [loading, setLoading] = useState(true);
  const rowRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    if (!curLine) return;
    setLoading(true);
    fetch(`/api/positions?line=${encodeURIComponent(curLine)}`)
      .then((r) => r.json())
      .then((d: Res) => setRes(d))
      .catch(() => setRes({ supported: false, reason: "네트워크 오류", trains: [] }))
      .finally(() => setLoading(false));
  }, [curLine]);

  // 20초마다 자동 갱신
  useEffect(() => {
    load();
    // 화면을 안 보고 있을 땐 부르지 않습니다 (실시간 조회 한도를 아낍니다)
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 20_000);
    // 돌아오면 그 즉시 다시 받습니다
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const stations = useMemo(() => lineStations(curLine), [curLine]);
  const color = lineColor(curLine);

  // 역 이름 → 그 역에 있는 열차들
  const byStation = useMemo(() => {
    const m = new Map<string, TrainPos[]>();
    for (const t of res?.trains ?? []) {
      if (t.updn !== dir) continue;
      if (!m.has(t.station)) m.set(t.station, []);
      m.get(t.station)!.push(t);
    }
    return m;
  }, [res, dir]);

  // 선택한 역이 화면 가운데 오도록 스크롤
  useEffect(() => {
    const el = rowRef.current?.querySelector<HTMLElement>(".lt-row.me");
    el?.scrollIntoView({ block: "center" });
  }, [stations, loading]);

  // 방향 이름: 그 방향으로 가는 열차들의 종착역 중 가장 많은 것
  const dirName = (d: "up" | "down") => {
    const counts = new Map<string, number>();
    for (const t of res?.trains ?? []) {
      if (t.updn !== d || !t.dest) continue;
      counts.set(t.dest, (counts.get(t.dest) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : d === "up" ? "상행" : "하행";
  };

  const trainCount = (res?.trains ?? []).filter((t) => t.updn === dir).length;

  return (
    <div className="lt-wrap">
      <div className="tt-head">
        <div className="tt-title">
          <b>실시간 열차 위치</b>
          <span style={{ color }}>{curLine}</span>
        </div>
        <button className="tt-close" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>

      {available.length > 1 && (
        <div className="tt-lines">
          {available.map((l) => (
            <button
              key={l.label}
              className={`lchip${l.label === curLine ? " on" : ""}`}
              onClick={() => setCurLine(l.label)}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}

      <div className="lt-meta">
        <span>{res?.updatedAt ? `${res.updatedAt} 기준` : loading ? "불러오는 중…" : ""}</span>
        <button className="lt-refresh" onClick={load} aria-label="새로고침">
          ↻ 새로고침
        </button>
      </div>

      <div className="lt-dirs">
        {(["up", "down"] as const).map((d) => (
          <button key={d} className={`lt-dir${dir === d ? " on" : ""}`} onClick={() => setDir(d)}>
            {dirName(d)} 방면
          </button>
        ))}
      </div>

      {res && res.supported === false && (
        <div className="tt-loading">
          {res.reason ?? "실시간 정보를 제공하지 않는 노선입니다"}
          <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 6, fontWeight: 500 }}>
            서울교통공사가 운영하는 노선만 실시간 위치가 공개돼요
          </div>
        </div>
      )}

      {res?.supported && stations.length === 0 && (
        <div className="tt-loading">이 노선의 역 순서 정보가 없어요</div>
      )}

      {res?.supported && stations.length > 0 && (
        <>
          <div className="lt-count">
            {dirName(dir)} 방면 열차 {trainCount}대 운행 중
          </div>
          <div className="lt-rail" ref={rowRef}>
            {stations.map((name) => {
              const here = byStation.get(name) ?? [];
              const me = name === station;
              return (
                <div className={`lt-row${me ? " me" : ""}`} key={name}>
                  <div className="lt-trains">
                    {here.map((t) => (
                      <span className="lt-train" key={t.trainNo} style={{ borderColor: color }}>
                        <b>{t.dest}</b>행 {t.status}
                        {t.express && <em className="lt-tag exp">급행</em>}
                        {t.last && <em className="lt-tag last">막차</em>}
                      </span>
                    ))}
                  </div>
                  <div className="lt-dotcol">
                    <span className="lt-line" style={{ background: color }} />
                    <span
                      className={`lt-dot${here.length ? " has" : ""}`}
                      style={here.length ? { background: color, borderColor: color } : { borderColor: color }}
                    />
                  </div>
                  <button
                    className="lt-name"
                    onClick={() => onStationClick?.(name)}
                    style={me ? { fontWeight: 800 } : undefined}
                  >
                    {name}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="tt-foot">출처: 서울열린데이터광장 실시간 열차 위치 · 20초마다 갱신</div>
        </>
      )}
    </div>
  );
}
