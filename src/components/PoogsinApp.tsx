"use client";

import { useState, useEffect } from "react";
import SchematicMap from "./SchematicMap";
import TimetableView from "./TimetableView";
import LiveTrainView from "./LiveTrainView";
import TrainStrip, { type TrainPos } from "./TrainStrip";
import {
  CAR_SEATS,
  MOCK_ARRIVALS,
  REMAINING_STATIONS,
  LEDGER,
  type SeatState,
} from "@/lib/data";
import { searchStations, STATION_COUNT } from "@/lib/stations";
import { stationNeighbors } from "@/lib/lines";
import { DAY_LABEL, type DayType } from "@/lib/holidays";
import { carsForLeg } from "@/lib/car-counts";

// 화면(뷰) 종류
type View = "home" | "car" | "seat" | "timetable" | "live";
// 홈 탭 내부 단계
type Stage = "map" | "station" | "detail";
// 검색 오버레이가 무엇을 고르는지
type SearchMode = "station" | "dep" | "arr";
// 하단 탭
type Tab = "home" | "wallet";

// 실시간 도착정보(서버 경로에서 받아오는 모양)
type ArrivalTrain = { msg: string; sec: number; min?: number; dest?: string };
type ArrivalGroup = { line: string; dir: string; updn?: "up" | "down"; trains: ArrivalTrain[] };
type Arrivals = { source: string; updatedAt: string; groups: ArrivalGroup[] };

// 경로검색 결과
type RouteLeg = {
  type: string; line?: string; color?: string; start?: string; end?: string;
  stationCount?: number; min?: number; way?: string; door?: string; distance?: number;
  stations?: string[];
  stationID?: number | null; // 승차역 ODsay ID (실제 시간표 조회용)
  wayCode?: number | null; // 1=상행/외선, 2=하행/내선
};

// 출발역의 실제 시간표 (/api/timetable)
type Departure = { min: number; dest: string };
// 서버는 평일/토/휴일 × 상하행을 한 번에 주고, 여기서 필요한 방향만 골라 씁니다.
type TimetableRes = {
  line?: string;
  upWay?: string;
  downWay?: string;
  today?: DayType;
  isHoliday?: boolean;
  lists?: Record<DayType, { up: Departure[]; down: Departure[] }>;
  error?: string;
};
type Timetable = {
  line?: string;
  wayLabel?: string;
  dayType?: DayType;
  departures: Departure[];
};
type RouteData = {
  from?: string; to?: string; totalTime?: number; payment?: number;
  transferCount?: number; stationCount?: number; legs: RouteLeg[]; error?: string;
};
type RouteTab = "time" | "transfer" | "fare" | "last";

// 칸 번호는 "열차 진행 방향 기준"으로 매겨집니다. 즉 1번 칸이 언제나 맨 앞입니다.
//
// 확인 방법(2026-08-18): 상·하행이 한 승강장을 쓰는 섬식 환승역에서, 같은 환승 통로를
// 양쪽 방향으로 접근해 ODsay가 주는 빠른환승 칸 번호를 비교했습니다.
//   교대(2→3호선) 10-4 ↔ 1-1 · 신도림(2→1호선) 7-2 ↔ 4-3 · 잠실(2→8호선) 1-1 ↔ 10-3
// 같은 물리적 위치인데 방향이 바뀌자 번호가 정확히 대칭으로 뒤집혔습니다.
// 번호가 차량에 고정돼 있다면 방향이 바뀌어도 같은 번호가 나와야 하므로,
// 이는 번호가 진행 방향 기준이라는 뜻입니다 → 화면에서 순서를 뒤집을 필요가 없습니다.
function orderCars(cars: number): number[] {
  return Array.from({ length: Math.max(1, cars) }, (_, i) => i + 1);
}

// 여러 후보 경로 중 탭 기준으로 최적 하나 고르기
function pickRoute(options: RouteData[], tab: RouteTab): RouteData | null {
  if (!options.length) return null;
  const sorted = [...options];
  const t = (r: RouteData) => r.totalTime ?? 999;
  if (tab === "transfer") sorted.sort((a, b) => (a.transferCount ?? 9) - (b.transferCount ?? 9) || t(a) - t(b));
  else if (tab === "fare") sorted.sort((a, b) => (a.payment ?? 0) - (b.payment ?? 0) || t(a) - t(b));
  else sorted.sort((a, b) => t(a) - t(b)); // time / last(막차는 시간표 연동 전까지 최단시간)
  return sorted[0];
}

export default function PoogsinApp() {
  const [view, setView] = useState<View>("home");
  const [stage, setStage] = useState<Stage>("map");
  const [tab, setTab] = useState<Tab>("home");

  const [dep, setDep] = useState<string | null>(null);
  const [arr, setArr] = useState<string | null>(null);

  // 선택된 역(도착정보 대상) + 역 검색
  const [selectedStation, setSelectedStation] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("station");
  const [query, setQuery] = useState("");

  // 경로검색
  const [routeOptions, setRouteOptions] = useState<RouteData[]>([]);
  const [routeErr, setRouteErr] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeTab, setRouteTab] = useState<RouteTab>("time");
  const [departMin, setDepartMin] = useState<number | null>(null); // 시간표가 없을 때만 쓰는 대체 발차 시각(분)

  // 출발역 실제 시간표
  const [timetable, setTimetable] = useState<Timetable | null>(null);
  const [ttLoading, setTtLoading] = useState(false);
  const [depIdx, setDepIdx] = useState<number | null>(null); // 시간표에서 고른 열차 번호
  const [pickedByUser, setPickedByUser] = useState(false); // 사용자가 이전/다음을 눌렀는지
  const [nowMin, setNowMin] = useState(() => nowMinutes()); // 30초마다 갱신되는 현재 시각

  // 전체 시간표 / 실시간 열차 위치 화면이 무엇을 보여줄지
  const [ttTarget, setTtTarget] = useState<{
    station: string;
    line: string | null;
    way: "up" | "down" | null;
  } | null>(null);
  const [liveTarget, setLiveTarget] = useState<{ station: string; line: string | null } | null>(null);

  // 탑승 칸을 고르는 중인 구간 (환승이 있으면 노선마다 따로 고릅니다)
  const [carLeg, setCarLeg] = useState<RouteLeg | null>(null);
  const [pickedTrain, setPickedTrain] = useState<TrainPos | null>(null); // 내가 탄 열차
  const [pickedCar, setPickedCar] = useState(3); // 내가 탄 칸

  const [points, setPoints] = useState(1240);
  const [revealed, setRevealed] = useState(false);
  const [pickedSeat, setPickedSeat] = useState<string | null>(null);
  const [alightFor, setAlightFor] = useState<{ row: "top" | "bottom"; i: number } | null>(null);
  const [seats, setSeats] = useState<{ top: SeatState[]; bottom: SeatState[] }>(() =>
    structuredClone(CAR_SEATS)
  );
  const [toast, setToast] = useState<string | null>(null);

  // 실시간 도착정보
  const [arrivals, setArrivals] = useState<Arrivals | null>(null);
  const [arrLoading, setArrLoading] = useState(false);

  // 역 클릭(station 단계)에 들어오면 실시간 도착정보를 불러옵니다.
  useEffect(() => {
    if (stage !== "station" || !selectedStation) return;
    setArrLoading(true);
    setArrivals(null);
    fetch(`/api/arrivals?station=${encodeURIComponent(selectedStation)}`)
      .then((r) => r.json())
      .then((d: Arrivals) => setArrivals(d))
      .catch(() => setArrivals({ source: "error", updatedAt: "", groups: [] }))
      .finally(() => setArrLoading(false));
  }, [stage, selectedStation]);

  // 검색에서 역 선택 → 모드(일반/출발/도착)에 따라 처리
  function pickStation(name: string) {
    setSearchOpen(false);
    setQuery("");
    setTab("home");
    if (searchMode === "dep") {
      setDep(name);
      setStage("map");
    } else if (searchMode === "arr") {
      setArr(name);
      setStage("map");
    } else {
      setSelectedStation(name);
      setStage("station");
    }
    setSearchMode("station");
  }

  function openSearch(mode: SearchMode) {
    setSearchMode(mode);
    setQuery("");
    setSearchOpen(true);
  }

  function showToast(msg: string) {
    setToast(msg);
    window.clearTimeout((showToast as any)._t);
    (showToast as any)._t = window.setTimeout(() => setToast(null), 2200);
  }

  function resetHome() {
    setStage("map");
    setDep(null);
    setArr(null);
    setRouteOptions([]);
    setRouteErr(null);
    setRouteTab("time");
  }

  // 전체 시간표 화면 열기 (도착정보의 방면 칸을 누르면 그 방향으로 열립니다)
  function openTimetable(station: string, line: string | null = null, way: "up" | "down" | null = null) {
    setTtTarget({ station, line, way });
    setView("timetable");
  }
  // 실시간 열차 위치 화면 열기
  function openLive(station: string, line: string | null = null) {
    setLiveTarget({ station, line });
    setView("live");
  }

  // 도착정보 시트에서 이 역을 출발/도착으로 지정 (지정 후 지도로 복귀)
  function chooseStart() {
    if (!selectedStation) return;
    setDep(selectedStation);
    setStage("map");
  }
  function chooseEnd() {
    if (!selectedStation) return;
    setArr(selectedStation);
    setStage("map");
  }

  // 출발·도착이 모두 정해지면 실제 경로 검색 (ODsay, 여러 후보)
  useEffect(() => {
    if (!dep || !arr) {
      setRouteOptions([]);
      setRouteErr(null);
      setDepartMin(null);
      return;
    }
    setRouteLoading(true);
    setRouteOptions([]);
    setRouteErr(null);
    fetch(`/api/route?from=${encodeURIComponent(dep)}&to=${encodeURIComponent(arr)}`)
      .then((r) => r.json())
      .then((d) => {
        setRouteOptions(d.options || []);
        setRouteErr(d.error || null);
        setDepartMin(nowMinutes()); // 발차 기본값 = 현재 시각
      })
      .catch(() => setRouteErr("네트워크 오류"))
      .finally(() => setRouteLoading(false));
  }, [dep, arr]);

  // 탭 기준으로 고른 현재 경로
  const route = pickRoute(routeOptions, routeTab);

  // 이 경로에서 처음 타는 지하철 구간 (= 시간표를 봐야 하는 역/방향)
  const boardLeg = route?.legs.find((l) => l.type === "subway") ?? null;
  const boardStationID = boardLeg?.stationID ?? null;
  const boardWayCode = boardLeg?.wayCode ?? null;
  // 열차를 타기 전까지 걸리는 시간(도보 등) — 발차 시각에서 거꾸로 빼줍니다.
  const preBoardMin = (() => {
    if (!route) return 0;
    let sum = 0;
    for (const l of route.legs) {
      if (l.type === "subway") break;
      sum += l.min || 0;
    }
    return sum;
  })();

  // 시계: 30초마다 현재 시각을 갱신 (화면을 켜둬도 "다음 열차"가 지나간 열차가 되지 않게)
  useEffect(() => {
    setNowMin(nowMinutes()); // 화면이 뜨는 순간 한 번 맞춰줍니다
    const id = window.setInterval(() => setNowMin(nowMinutes()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // 출발역의 실제 시간표 불러오기
  useEffect(() => {
    if (!boardStationID) {
      setTimetable(null);
      setDepIdx(null);
      return;
    }
    setTtLoading(true);
    setTimetable(null);
    setDepIdx(null);
    setPickedByUser(false);
    fetch(`/api/timetable?stationID=${boardStationID}`)
      .then((r) => r.json())
      .then((d: TimetableRes) => {
        const day = d.today ?? "weekday";
        const way = boardWayCode === 2 ? "down" : "up";
        const departures = d.lists?.[day]?.[way] ?? [];
        setTimetable(
          departures.length
            ? {
                line: d.line,
                wayLabel: way === "up" ? d.upWay : d.downWay,
                dayType: day,
                departures,
              }
            : null
        );
      })
      .catch(() => setTimetable(null))
      .finally(() => setTtLoading(false));
  }, [boardStationID, boardWayCode]);

  // 지금 출발해서 탈 수 있는 첫 열차 (도보 이동 시간 감안)
  const firstBoardIdx = (() => {
    if (!timetable?.departures.length) return 0;
    const i = timetable.departures.findIndex((d) => d.min >= nowMin + preBoardMin);
    return i < 0 ? timetable.departures.length - 1 : i; // 오늘 남은 열차가 없으면 막차
  })();
  const noMoreToday =
    !!timetable?.departures.length &&
    timetable.departures[timetable.departures.length - 1].min < nowMin + preBoardMin;

  // 시간표가 준비되면(또는 시간이 흐르면) 다음 열차를 자동 선택.
  // 사용자가 직접 고른 뒤에는 두되, 그 열차가 이미 떠났으면 다음 열차로 밀어줍니다.
  useEffect(() => {
    if (!timetable) return;
    setDepIdx((cur) => (!pickedByUser || cur == null || cur < firstBoardIdx ? firstBoardIdx : cur));
  }, [timetable, pickedByUser, firstBoardIdx]);

  // 실제 발차 시각 (시간표가 없으면 기존 방식으로 대체)
  const picked = timetable && depIdx != null ? timetable.departures[depIdx] : null;
  const boardAt = picked ? picked.min : (departMin ?? nowMin) + preBoardMin;
  // RouteDetail은 "여정 시작 시각"부터 구간을 누적하므로 도보 시간만큼 앞당겨 넘깁니다.
  const journeyStart = boardAt - preBoardMin;

  // 이 구간 열차가 몇 량인지 (노선별로 다르고, 지선·셔틀은 더 짧습니다)
  const carInfo = carsForLeg(carLeg?.line ?? "", [
    ...(carLeg?.stations ?? []),
    carLeg?.start,
    carLeg?.end,
  ]);
  // 진행 방향(위쪽)에 맞춘 칸 나열 순서
  const carOrder = orderCars(carInfo.cars);

  // 빠른 환승 칸 번호 (ODsay door가 "1-1"처럼 오면 앞 숫자가 칸 번호)
  const quickCar = (() => {
    const q = quickTransfer(carLeg?.door);
    const n = q ? Number(q.split("-")[0]) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= carInfo.cars ? n : 0;
  })();

  // 짧은 열차로 바뀌면 없는 칸이 선택된 채로 남지 않게 맞춰줍니다.
  useEffect(() => {
    setPickedCar((c) => Math.min(c, carInfo.cars));
  }, [carInfo.cars]);

  function stepTrain(delta: number) {
    if (!timetable) {
      // 시간표를 못 받은 경우에만 예전처럼 3분 단위로 움직입니다.
      setDepartMin((m) => {
        const base = m ?? nowMin;
        return delta < 0 ? Math.max(nowMin, base - 3) : base + 3;
      });
      return;
    }
    setPickedByUser(true);
    setDepIdx((i) => {
      const cur = i ?? firstBoardIdx;
      // 이미 떠난 열차로는 되돌아갈 수 없습니다.
      return Math.min(timetable.departures.length - 1, Math.max(firstBoardIdx, cur + delta));
    });
  }

  const regCount = seats.top.concat(seats.bottom).filter((s) => s.kind === "occupied").length;
  const neighbors = selectedStation ? stationNeighbors(selectedStation) : null;

  // 지도 포커스: 출발~도착 사이 "구간"만 강조 + 경로 위 역만 진하게
  const routeLegs = route ? route.legs.filter((l) => l.type === "subway") : [];
  const routeStations = Array.from(new Set(routeLegs.flatMap((l) => l.stations || [])));
  const mapFocus =
    dep && arr && route && routeLegs.length
      ? {
          dep,
          arr,
          stations: routeStations,
          legs: routeLegs.map((l) => ({ line: l.line || "", start: l.start || "", end: l.end || "" })),
        }
      : null;

  // 좌석 클릭 (빈 좌석 → 하차역 입력 모달)
  function tapSeat(row: "top" | "bottom", i: number, s: SeatState) {
    if (s.kind !== "free") return;
    setPickedSeat(`${row}-${i}`);
    setAlightFor({ row, i });
  }

  // 하차역 선택 → 등록(공급) → 포인트 적립
  function registerAlight(stationName: string, stopsLeft: number) {
    if (!alightFor) return;
    setSeats((prev) => {
      const next = structuredClone(prev);
      next[alightFor.row][alightFor.i] = { kind: "occupied", stopsLeft };
      return next;
    });
    setPoints((p) => p + 15);
    setAlightFor(null);
    setPickedSeat(null);
    showToast(`${stationName} 하차 등록 완료 · +15P 적립`);
  }

  // 하차예정지 확인(수요) → 포인트 차감/공개
  function reveal() {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (regCount === 0) {
      showToast("아직 등록된 하차 정보가 없어요");
      return;
    }
    if (points < 1) {
      showToast("포인트가 부족해요 (광고 시청으로 대체 가능)");
      return;
    }
    setPoints((p) => p - 1);
    setRevealed(true);
    showToast("1P 차감 · 하차예정지 공개");
  }

  return (
    <div className="app">
      <StatusBar time={`${Math.floor(nowMin / 60) % 24}:${String(nowMin % 60).padStart(2, "0")}`} />

      {/* ====================== 지갑 탭 ====================== */}
      {tab === "wallet" && view === "home" && (
        <div className="view">
          <div className="appbar">포인트 지갑</div>
          <div className="scroll pad">
            <div className="balance">
              <small>보유 포인트</small>
              <div className="amt">
                {points.toLocaleString()}
                <span> P</span>
              </div>
            </div>
            <div className="sect-label">최근 내역</div>
            {LEDGER.map((l, idx) => (
              <div className="ledger" key={idx}>
                <span className={`lic ${l.type}`}>{l.type === "plus" ? "▲" : "▼"}</span>
                <span className="ltxt">
                  <b>{l.title}</b>
                  <small>{l.when}</small>
                </span>
                <span className={`delta ${l.type === "plus" ? "up" : "dn"}`}>{l.delta}</span>
              </div>
            ))}
          </div>
          <BottomNav tab={tab} onTab={setTab} />
        </div>
      )}

      {/* ====================== 홈 탭 (지도 흐름) ====================== */}
      {tab === "home" && view === "home" && (
        <div className="view">
          {/* 상단: 검색창(출발·도착 미설정) 또는 경로 입력창 */}
          <div className="topzone">
            {!dep && !arr ? (
              <button className="searchbar" onClick={() => openSearch("station")}>
                <span className="mag" /> 역 이름으로 검색 (수도권 {STATION_COUNT}개 역)
              </button>
            ) : (
              <>
                {stage === "detail" ? (
                  // 상세 경로 화면: 뒤로가기(경로 유지) + 초기화(✕)
                  <div className="dj-bar">
                    <button className="back" onClick={() => setStage("map")} aria-label="뒤로">
                      ‹
                    </button>
                    <b>
                      {dep ? withYeok(dep) : ""} → {arr ? withYeok(arr) : ""}
                    </b>
                    <button className="mini" onClick={resetHome} aria-label="초기화">
                      ✕
                    </button>
                  </div>
                ) : (
                <div className="rin">
                <div className="rin-row">
                  <span className="pin dep" />
                  <button
                    className="val"
                    style={!dep ? { color: "var(--faint)", fontWeight: 500 } : undefined}
                    onClick={() => openSearch("dep")}
                  >
                    {dep ? withYeok(dep) : "출발역 선택"}
                  </button>
                </div>
                <div className="rin-row">
                  <span className="pin arr" />
                  <button
                    className="val"
                    style={!arr ? { color: "var(--faint)", fontWeight: 500 } : undefined}
                    onClick={() => openSearch("arr")}
                  >
                    {arr ? withYeok(arr) : "도착역 선택"}
                  </button>
                </div>
                <div className="rin-side" style={{ position: "absolute", right: 12, top: 14 }}>
                  <button className="mini" onClick={resetHome} aria-label="초기화">✕</button>
                </div>
                </div>
                )}
                {dep && arr && (
                  <div className="timesel" style={{ marginTop: 8, border: "1px solid var(--line-2)", borderRadius: 12 }}>
                    <button
                      onClick={() => stepTrain(-1)}
                      disabled={timetable ? (depIdx ?? 0) <= firstBoardIdx : false}
                    >
                      ‹ 이전
                    </button>
                    <button className="mid" style={{ lineHeight: 1.25 }}>
                      {ttLoading ? (
                        "시간표 확인 중…"
                      ) : (
                        <>
                          <span>
                            {boardAt >= 1440 ? "내일 " : "오늘 "}
                            {fmtAmPm(boardAt)} 발차
                          </span>
                          {picked && (
                            <small
                              style={{ display: "block", color: "var(--faint)", fontSize: 10.5, fontWeight: 500 }}
                            >
                              {boardLeg?.start} · {picked.dest ? `${picked.dest}행` : timetable?.wayLabel}
                              {noMoreToday
                                ? " · 오늘 운행 종료(막차)"
                                : boardAt - preBoardMin > nowMin
                                  ? ` · ${boardAt - preBoardMin - nowMin}분 뒤`
                                  : " · 지금"}
                            </small>
                          )}
                          {!picked && !ttLoading && (
                            <small
                              style={{ display: "block", color: "var(--faint)", fontSize: 10.5, fontWeight: 500 }}
                            >
                              시간표 없음 · 예상 시각
                            </small>
                          )}
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => stepTrain(1)}
                      disabled={timetable ? (depIdx ?? 0) >= timetable.departures.length - 1 : false}
                    >
                      다음 ›
                    </button>
                  </div>
                )}
                {dep && arr && stage !== "detail" && (
                  <div className="tabs" style={{ marginTop: 8, borderTop: "1px solid var(--line-2)", borderRadius: 12 }}>
                    <button className={routeTab === "time" ? "on" : ""} onClick={() => setRouteTab("time")}>최단시간</button>
                    <button className={routeTab === "transfer" ? "on" : ""} onClick={() => setRouteTab("transfer")}>최소환승</button>
                    <button className={routeTab === "fare" ? "on" : ""} onClick={() => setRouteTab("fare")}>최저요금</button>
                    <button
                      className={routeTab === "last" ? "on" : ""}
                      onClick={() => {
                        setRouteTab("last");
                        if (timetable && timetable.departures.length) {
                          const lastIdx = timetable.departures.length - 1;
                          setPickedByUser(true);
                          setDepIdx(lastIdx);
                          showToast(`이 역 막차는 ${fmtAmPm(timetable.departures[lastIdx].min)}입니다`);
                        } else {
                          showToast("이 역의 시간표를 받지 못했어요");
                        }
                      }}
                    >
                      막차
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 지도 or 상세경로 */}
          {stage !== "detail" ? (
            <SchematicMap
              onStationClick={(name) => {
                setSelectedStation(name);
                setStage("station");
              }}
              selected={selectedStation}
              popoverOpen={stage === "station"}
              focus={mapFocus}
              onStart={chooseStart}
              onEnd={chooseEnd}
              onWaypoint={() => showToast("경유지 추가는 추후 지원")}
              onTimetable={() => selectedStation && openTimetable(selectedStation, neighbors?.line ?? null)}
              onLive={() => selectedStation && openLive(selectedStation, neighbors?.line ?? null)}
            />
          ) : (
            <RouteDetail
              route={route}
              departAt={journeyStart}
              boardDest={picked?.dest ?? null}
              onBoard={(leg) => {
                setCarLeg(leg);
                setPickedTrain(null); // 구간이 바뀌면 열차도 다시 고릅니다
                setView("car");
              }}
            />
          )}

          {/* 지도 위 FAB (깨끗한 홈에서만) */}
          {stage === "map" && !dep && !arr && (
            <>
              <button className="fab" style={{ left: 14, bottom: 78 }}>
                <span className="locpin" /> 내 주변 역
              </button>
              <button className="fab round" style={{ right: 14, bottom: 78 }}>
                ◎
              </button>
            </>
          )}

          {/* 역 클릭: 팝오버 + 도착정보 시트 */}
          {stage === "station" && (
            <>
              <div className="overlay-scrim" onClick={() => setStage("map")} />
              <div className="sheet">
                <div className="grab" />
                <div className="st-step">
                  <button
                    className="st-side left"
                    disabled={!neighbors?.prev}
                    onClick={() => neighbors?.prev && setSelectedStation(neighbors.prev)}
                  >
                    {neighbors?.prev ? `‹ ${neighbors.prev}` : ""}
                  </button>
                  <span className="st-cur">
                    {neighbors && (
                      <span className="st-line" style={{ background: neighbors.color }}>{neighbors.indicator}</span>
                    )}
                    {selectedStation}
                  </span>
                  <button
                    className="st-side right"
                    disabled={!neighbors?.next}
                    onClick={() => neighbors?.next && setSelectedStation(neighbors.next)}
                  >
                    {neighbors?.next ? `${neighbors.next} ›` : ""}
                  </button>
                </div>
                <div className="sheet-h">
                  <b>도착 정보</b>
                  <span className="t">
                    {arrivals?.updatedAt ? `${arrivals.updatedAt} ` : ""}
                    {arrivals?.source === "live" ? "· LIVE " : arrivals?.source === "sample" ? "· 샘플 " : ""}↻
                  </span>
                </div>

                {arrLoading && (
                  <div style={{ padding: "18px 2px", color: "var(--faint)", fontSize: 13 }}>
                    실시간 도착정보 불러오는 중…
                  </div>
                )}

                {!arrLoading && arrivals && arrivals.groups.length === 0 && (
                  <>
                    <div style={{ padding: "2px 2px 10px", color: "var(--warn)", fontSize: 11.5, lineHeight: 1.5, fontWeight: 600 }}>
                      샘플 키가 혼잡해 예시로 표시 중 · 내 API 키를 넣으면 실시간으로 바뀝니다
                    </div>
                    <div className="arrcards" style={{ maxHeight: 240, overflowY: "auto" }}>
                      {MOCK_ARRIVALS.map((g, i) => (
                        <button
                          className="arrcard tappable"
                          key={i}
                          onClick={() => selectedStation && openTimetable(selectedStation, g.line, null)}
                        >
                          <div className="dst">
                            <span>{g.line} · {g.dir}</span>
                            <span className="chev">›</span>
                          </div>
                          {g.trains.map((t, j) => (
                            <div className="t2" key={j}>
                              <span>{j === 0 ? "이번" : "다음"}</span>
                              <em>{t.msg}</em>
                            </div>
                          ))}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {!arrLoading && arrivals && arrivals.groups.length > 0 && (
                  <div className="arrcards" style={{ maxHeight: 240, overflowY: "auto" }}>
                    {arrivals.groups.map((g, i) => (
                      <button
                        className="arrcard tappable"
                        key={i}
                        onClick={() =>
                          selectedStation && openTimetable(selectedStation, g.line, g.updn ?? null)
                        }
                      >
                        <div className="dst">
                          <span>{dirTitle(g)}</span>
                          <span className="chev">›</span>
                        </div>
                        {g.trains.map((t, j) => (
                          <div className="t2" key={j}>
                            <span>{t.dest ? `${t.dest}행` : j === 0 ? "이번" : "다음"}</span>
                            <em>{arrivalText(t)}</em>
                          </div>
                        ))}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* 경로 요약 시트 (출발·도착 모두 선택 시) */}
          {dep && arr && stage !== "station" && stage !== "detail" && (
            routeLoading ? (
              <div className="sheet">
                <div className="grab" />
                <div style={{ padding: "18px 2px", color: "var(--faint)", fontSize: 13 }}>경로 검색 중…</div>
              </div>
            ) : route && route.legs.some((l) => l.type === "subway") ? (
              <div className="sheet" onClick={() => setStage("detail")} style={{ cursor: "pointer" }}>
                <div className="grab" />
                <div className="rs-head">
                  <span className="dur">{route.totalTime}분</span>
                  <span className="sub">
                    {fmtAmPm(journeyStart)} – {fmtAmPm(journeyStart + (route.totalTime || 0))} · 환승 {route.transferCount}회 · {route.payment?.toLocaleString()}원
                  </span>
                </div>
                <div className="segbar">
                  {route.legs
                    .filter((l) => l.type === "subway")
                    .flatMap((l, i, a) => {
                      const els = [
                        <span key={`s${i}`} className="seg" style={{ flex: Math.max(1, l.stationCount || 1), background: l.color }}>
                          <small>{l.line}</small>
                        </span>,
                      ];
                      if (i < a.length - 1)
                        els.push(<span key={`g${i}`} className="seg" style={{ flex: 0.6, background: "var(--line-2)" }} />);
                      return els;
                    })}
                </div>
                <div className="seg-ends">
                  <span>{dep}</span>
                  <span>{arr}</span>
                </div>
                <div style={{ textAlign: "center", color: "var(--faint)", fontSize: 11, marginTop: 12 }}>
                  ▲ 눌러서 상세 경로 보기
                </div>
              </div>
            ) : (
              <div className="sheet">
                <div className="grab" />
                <div style={{ padding: "14px 2px", color: "var(--muted)", fontSize: 12.5, lineHeight: 1.5 }}>
                  {routeErr ? `경로를 찾지 못했어요 (${routeErr})` : "경로를 찾지 못했어요"}
                </div>
              </div>
            )
          )}

          {stage === "map" && !dep && !arr && <BottomNav tab={tab} onTab={setTab} />}
        </div>
      )}

      {/* ====================== 전체 시간표 ====================== */}
      {view === "timetable" && ttTarget && (
        <div className="view">
          <div className="appbar">
            <button className="back" onClick={() => setView("home")}>
              ‹
            </button>
            전체 시간표
          </div>
          <div className="scroll">
            <TimetableView
              station={ttTarget.station}
              line={ttTarget.line}
              initialWay={ttTarget.way}
              nowMin={nowMin}
              onClose={() => setView("home")}
            />
          </div>
        </div>
      )}

      {/* ====================== 실시간 열차 위치 ====================== */}
      {view === "live" && liveTarget && (
        <div className="view">
          <div className="appbar">
            <button className="back" onClick={() => setView("home")}>
              ‹
            </button>
            실시간 열차 위치
          </div>
          <div className="scroll">
            <LiveTrainView
              station={liveTarget.station}
              line={liveTarget.line}
              onClose={() => setView("home")}
              onStationClick={(name) => {
                setSelectedStation(name);
                setStage("station");
                setView("home");
              }}
            />
          </div>
        </div>
      )}

      {/* ====================== 칸 선택 ====================== */}
      {view === "car" && (
        <div className="view">
          <div className="appbar">
            <button className="back" onClick={() => setView("home")}>
              ‹
            </button>
            {carLeg?.line ? `${carLeg.line} 탑승 칸 선택` : "탑승한 칸 선택"}
          </div>
          <div className="scroll pad">
            {carLeg && (
              <div className="car-ctx">
                <span className="vj-line" style={{ background: carLeg.color }}>{carLeg.line}</span>
                <b>{withYeok(carLeg.start || "")}</b>
                {carLeg.way && <small>{withYeok(carLeg.way)} 방면</small>}
              </div>
            )}
            {carLeg?.line && carLeg?.start && (
              <TrainStrip
                line={carLeg.line}
                boardStation={carLeg.start}
                endStation={carLeg.end}
                wayCode={carLeg.wayCode}
                fallbackLabel={
                  picked ? `${hhmm(picked.min)} ${picked.dest ? `${picked.dest}행` : ""}`.trim() : null
                }
                selected={pickedTrain}
                onSelect={setPickedTrain}
              />
            )}

            <p className="platform-hint">지금 서 계신 승강장 칸을 눌러주세요</p>

            {/* 열차는 세로로 세우고, 진행 방향은 언제나 위쪽입니다.
                1번 칸이 앞인지 뒤인지는 진행 방향(상행/하행)에 따라 자동으로 정해집니다. */}
            <div className="cars-dir">
              <span className="cars-arrow" />
              {carLeg?.way ? `${withYeok(carLeg.way)} 방면` : "진행 방향"}
            </div>
            <div className="cars">
              {carOrder.map((n) => (
                <button
                  className={`carrow${n === pickedCar ? " sel" : ""}`}
                  key={n}
                  onClick={() => setPickedCar(n)}
                >
                  <span className="carrow-n">{n}번 칸</span>
                  <span className="carrow-tags">
                    {n === quickCar && <em className="ct fast">빠른환승</em>}
                  </span>
                </button>
              ))}
            </div>
            <div className="cars-note">
              1번 칸이 맨 앞(진행 방향) · {carLeg?.line} {carInfo.cars}량
              {carInfo.label ? ` (${carInfo.label})` : ""}
              {!carInfo.known ? " · 량수 자료 없어 기본값" : ""}
            </div>

            <div className="infobox">
              <b style={{ color: "var(--ink)" }}>{pickedCar}번 칸</b> 선택됨
              {quickCar && carLeg?.end ? (
                <>
                  {" "}· {carLeg.end} <b style={{ color: "var(--good)" }}>빠른 환승</b>은 {quickTransfer(carLeg.door)}이 유리합니다.
                </>
              ) : null}
            </div>
          </div>
          <div className="sticky-cta">
            <button className="btn" onClick={() => setView("seat")}>
              {pickedCar}번 칸 좌석 보기 →
            </button>
          </div>
        </div>
      )}

      {/* ====================== 좌석 도식 ====================== */}
      {view === "seat" && (
        <div className="view">
          <div className="appbar">
            <button className="back" onClick={() => setView("car")}>
              ‹
            </button>
            {pickedCar}번 칸 좌석
          </div>
          <div className="scroll pad">
            <div className="banner">
              <span className="bnum">{pickedCar}</span>
              <span className="btxt">
                타고 계신 <b>{pickedCar}번 칸</b>에<br />
                하차역 입력된 좌석 <b>{regCount}개</b>
              </span>
            </div>

            <div className={`carbody ${revealed ? "revealed" : ""}`}>
              <div className="aisle">◁ 진행방향</div>
              <SeatBench row="top" seats={seats.top} pickedSeat={pickedSeat} onTap={tapSeat} />
              <div className="aisle">· · · · · · 통 로 · · · · · ·</div>
              <SeatBench row="bottom" seats={seats.bottom} pickedSeat={pickedSeat} onTap={tapSeat} />
            </div>

            <div className="legendrow">
              <span>
                <span className="lgc free" />
                앉을 수 있음
              </span>
              <span>
                <span className="lgc oc" />
                점유(등록됨)
              </span>
              <span>
                <span className="lgc pr" />
                교통약자석
              </span>
            </div>

            <div className="reveal-hint">
              {revealed ? (
                <>
                  공개됨 · 점유 좌석의 <b>하차까지 남은 역</b>이 배지로 표시됩니다
                </>
              ) : (
                "점유 좌석의 하차 시점은 가려져 있어요"
              )}
            </div>
          </div>
          <div className="sticky-cta">
            <button className={`btn ${revealed ? "ghost" : ""}`} onClick={reveal}>
              {revealed ? (
                "다시 가리기"
              ) : (
                <>
                  하차예정지 확인하기 <small>1P 또는 광고 1회</small>
                </>
              )}
            </button>
          </div>

          {/* 하차역 입력 모달 */}
          {alightFor && (
            <div className="modal-scrim" onClick={() => { setAlightFor(null); setPickedSeat(null); }}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="grab" />
                <h3>하차역을 알려주세요</h3>
                <p className="sub">간단히 등록하면 +15P가 적립됩니다 (공급)</p>
                <div className="stn-list">
                  {REMAINING_STATIONS.map((st, idx) => (
                    <button className="stn-item" key={st.name} onClick={() => registerAlight(st.name, idx + 1)}>
                      <span>{st.name}</span>
                      <small>{st.line}</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ====================== 역 검색 오버레이 ====================== */}
      {searchOpen && (
        <div className="search-overlay">
          <div className="search-bar-row">
            <button
              className="back"
              onClick={() => {
                setSearchOpen(false);
                setQuery("");
              }}
            >
              ‹
            </button>
            <div className="search-field">
              <span className="mag" />
              <input
                className="search-input"
                autoFocus
                placeholder={
                  searchMode === "dep" ? "출발역 검색" : searchMode === "arr" ? "도착역 검색" : "역 이름을 입력하세요"
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="scroll">
            {query.trim() === "" ? (
              <div className="search-hint">
                수도권 {STATION_COUNT}개 역 검색
                <br />
                예: 강남, 서울, 신도림, 부평, 사당…
              </div>
            ) : (
              <div className="pad" style={{ paddingTop: 8 }}>
                <div className="stn-list">
                  {searchStations(query).map((s) => (
                    <button className="stn-item" key={s.name} onClick={() => pickStation(s.name)}>
                      <span>{s.name}</span>
                      <span className="station-lines">
                        {s.lines.map((l) => (
                          <span className="lb" style={{ background: lineColor(l) }} key={l}>
                            {l}
                          </span>
                        ))}
                      </span>
                    </button>
                  ))}
                  {searchStations(query).length === 0 && (
                    <div className="search-hint">검색 결과가 없어요</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast" dangerouslySetInnerHTML={{ __html: toast }} />}
    </div>
  );
}

// 역명에 "역"을 붙이되 이미 "역"으로 끝나면 그대로 (서울역역 방지)
function withYeok(name: string): string {
  return name.endsWith("역") ? name : `${name}역`;
}

// 도착 표시: "3번째 전역" 같은 말 대신 "N분"으로 (실시간 데이터 기준 도착까지 남은 시간)
//
// 주의: 서울 API가 남은 시간(초)을 주지 않는 노선이 있습니다(신분당선 등 비서울교통공사 운영).
//       그런 경우는 분을 지어내지 않고, 남은 정거장 수로 보여줍니다.
function arrivalText(t: ArrivalTrain): string {
  if (t.min && t.min > 0) return `${t.min}분`;
  const msg = (t.msg || "").trim();
  if (/도착/.test(msg)) return "도착";
  if (/진입/.test(msg)) return "곧 도착";
  if (/출발/.test(msg)) return "출발";
  const stops = msg.match(/\[?(\d+)\]?번째\s*전역/);
  if (stops) return `${stops[1]}정거장`;
  return msg || "정보 없음";
}

// "2호선 · 성수행 - 강남구청방면" → "성수 방면" 처럼 짧게
function dirTitle(g: ArrivalGroup): string {
  const dir = (g.dir || "").trim();
  const via = dir.match(/-\s*(.+?)방면/);
  if (via) return `${via[1].trim()} 방면`;
  const dest = dir.match(/^([^행]+)행/);
  if (dest) return `${dest[1].trim()} 방면`;
  return dir || `${g.line} 방면`;
}

// 현재 시각(자정 기준 분)
function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
// 분 → "20:27" 형식 (상세 경로처럼 촘촘한 곳에서 씁니다)
function hhmm(min: number): string {
  return `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// ODsay의 door 값은 두 가지로 옵니다.
//  - "L"/"R"  → 내리는 문 방향
//  - "1-1"    → 빠른 환승 위치(몇 번째 칸-문)
function doorSide(d?: string): string {
  if (d === "L") return "왼쪽";
  if (d === "R") return "오른쪽";
  return "";
}
function quickTransfer(d?: string): string {
  if (!d || d === "null" || d === "undefined") return "";
  return /^\d+-\d+$/.test(d) ? d : "";
}

// 분 → "오후 8:27" 형식
function fmtAmPm(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const m = ((min % 60) + 60) % 60;
  const ap = h24 < 12 ? "오전" : "오후";
  const h12 = h24 % 12 || 12;
  return `${ap} ${h12}:${String(m).padStart(2, "0")}`;
}

// 노선명 → 대표 색상 (배지용)
function lineColor(line: string): string {
  const map: Record<string, string> = {
    "1호선": "#0052A4", "2호선": "#00A84D", "3호선": "#EF7C1C", "4호선": "#00A5DE",
    "5호선": "#996CAC", "6호선": "#CD7C2F", "7호선": "#747F00", "8호선": "#E6186C",
    "9호선": "#BDB092",
  };
  return map[line] ?? "#6B7280";
}

// ---- 작은 조각 컴포넌트들 ----

function StatusBar({ time }: { time: string }) {
  return (
    <div className="statusbar">
      <span>{time}</span>
      <span className="sig">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function BottomNav({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const items: { key: Tab | "route" | "me"; label: string }[] = [
    { key: "home", label: "홈" },
    { key: "route", label: "경로" },
    { key: "wallet", label: "지갑" },
    { key: "me", label: "내정보" },
  ];
  return (
    <div className="nav">
      {items.map((it) => (
        <button
          className={`navi ${tab === it.key ? "on" : ""}`}
          key={it.key}
          onClick={() => (it.key === "home" || it.key === "wallet") && onTab(it.key)}
        >
          <i />
          {it.label}
        </button>
      ))}
    </div>
  );
}

function SeatBench({
  row,
  seats,
  pickedSeat,
  onTap,
}: {
  row: "top" | "bottom";
  seats: SeatState[];
  pickedSeat: string | null;
  onTap: (row: "top" | "bottom", i: number, s: SeatState) => void;
}) {
  return (
    <div className={`bench ${row === "bottom" ? "bottom" : ""}`}>
      {seats.map((s, i) => {
        const cls =
          s.kind === "priority" ? "seat pri" : s.kind === "occupied" ? "seat occ" : "seat";
        const picked = pickedSeat === `${row}-${i}` ? " picked" : "";
        return (
          <div className={cls + picked} key={i} onClick={() => onTap(row, i, s)}>
            {s.kind === "priority" ? "♿" : s.kind === "occupied" ? "" : i + 1}
            {s.kind === "occupied" && <span className="badge">{s.stopsLeft}역</span>}
          </div>
        );
      })}
    </div>
  );
}

// 상세 경로 화면 (ODsay 실데이터)
function RouteDetail({
  route,
  departAt,
  boardDest,
  onBoard,
}: {
  route: RouteData | null;
  departAt: number;
  boardDest?: string | null; // 첫 열차 행선지 (시간표에서 고른 열차)
  onBoard: (leg: RouteLeg) => void; // 그 노선의 탑승 칸 선택으로 이동
}) {
  if (!route || route.error || !route.legs.some((l) => l.type === "subway")) {
    return (
      <div className="scroll pad" style={{ background: "var(--surface)", color: "var(--muted)", fontSize: 13 }}>
        경로를 불러오지 못했어요{route?.error ? ` (${route.error})` : ""}.
      </div>
    );
  }
  // ODsay가 알려주는 총 소요시간은 구간 시간의 단순 합보다 큽니다.
  // 그 차이가 곧 "환승역에서 다음 열차를 기다리는 시간"이라, 환승 지점에 나눠 넣어
  // 구간별 시각을 더한 값이 총 소요시간과 정확히 맞게 만듭니다.
  const rideCount = route.legs.filter((l) => l.type === "subway").length;
  const legSum = route.legs.reduce((s, l) => s + (l.min || 0), 0);
  const transfers = Math.max(0, rideCount - 1);
  const slack = Math.max(0, (route.totalTime || 0) - legSum);
  const waitEach = transfers > 0 ? Math.floor(slack / transfers) : 0;
  const waitRest = transfers > 0 ? slack - waitEach * transfers : 0; // 나머지는 첫 환승에

  let acc = departAt;
  let seenRides = 0;
  const timed = route.legs.map((l, i) => {
    if (l.type === "subway") {
      if (seenRides > 0) acc += waitEach + (seenRides === 1 ? waitRest : 0);
      seenRides++;
    }
    const start = acc;
    acc += l.min || 0;
    return { l, i, start };
  });
  const arriveAt = Math.max(acc, departAt + (route.totalTime || 0));

  // 지하철 구간만 뽑되, 원래 순서(i)를 기억해 바로 뒤의 도보 구간을 찾을 수 있게 합니다.
  const rides = timed.filter((x) => x.l.type === "subway");

  return (
    <div className="scroll" style={{ background: "var(--surface)" }}>
      <div className="pad">
        <div className="dj-head">
          <div className="dur">{route.totalTime}분</div>
          <div className="sub">
            {fmtAmPm(departAt)} – {fmtAmPm(arriveAt)} · {route.payment?.toLocaleString()}원
          </div>
          <div className="dj-note">환승 {route.transferCount}회 · {route.stationCount}정거장 · 선택 발차 기준</div>
        </div>

        {/* 한눈에 보는 일직선 경로 */}
        <RouteFlow rides={rides} arriveAt={arriveAt} />

        {/* 세로형 상세 경로 */}
        <div className="vj">
          {rides.map(({ l, i, start }, k) => {
            const alightAt = start + (l.min || 0);
            const isLast = k === rides.length - 1;
            // 이 열차에서 내린 뒤의 도보 구간(환승 통로 또는 목적지까지)
            const walk = timed[i + 1]?.l.type === "walk" ? timed[i + 1].l : null;
            const nextRide = rides[k + 1];
            const waitMin = nextRide
              ? Math.max(0, nextRide.start - (alightAt + (walk?.min || 0)))
              : 0;
            const color = l.color || "#6B7280";
            return (
              <div key={k}>
                {/* 승차역 */}
                <div className="vj-node">
                  <span className="vj-time">{hhmm(start)}</span>
                  <span className="vj-mark">
                    <span className="vj-ic" style={{ borderColor: color, color }}>
                      ●
                    </span>
                    <span className="vj-bar" style={{ background: color }} />
                  </span>
                  <span className="vj-body">
                    <span className="vj-station">
                      <em className="vj-line" style={{ background: color }}>
                        {l.line}
                      </em>
                      {withYeok(l.start || "")}
                    </span>
                    {l.way && <span className="vj-sub">{withYeok(l.way)} 방면</span>}
                    {quickTransfer(l.door) && (
                      <span className="vj-sub">빠른 환승 {quickTransfer(l.door)}</span>
                    )}
                    {k === 0 && boardDest && (
                      <span className="vj-train">
                        {hhmm(start)} {boardDest}행
                      </span>
                    )}
                    <span className="vj-meta">
                      {l.stationCount}개 역 이동 · {l.min}분
                    </span>
                    {/* 환승이 있으면 노선마다 칸을 새로 골라야 해서 구간별로 둡니다 */}
                    <button className="vj-cta" onClick={() => onBoard(l)} style={{ borderColor: color }}>
                      <em style={{ background: color }}>{l.line}</em>
                      탑승 칸 선택
                      <span className="vj-cta-chev">›</span>
                    </button>
                  </span>
                </div>

                {/* 하차역 */}
                <div className="vj-node">
                  <span className="vj-time">{hhmm(alightAt)}</span>
                  <span className="vj-mark">
                    <span
                      className={`vj-ic${isLast ? " goal" : " walk"}`}
                      style={isLast ? undefined : { borderColor: "var(--line-2)" }}
                    >
                      {isLast ? "◎" : "↓"}
                    </span>
                    {!isLast && <span className="vj-bar dashed" />}
                  </span>
                  <span className="vj-body">
                    <span className="vj-station">{withYeok(l.end || "")}</span>
                    {doorSide(l.door) && <span className="vj-sub">내리는 문: {doorSide(l.door)}</span>}
                    {isLast ? (
                      walk && (walk.min || 0) > 0 ? (
                        <span className="vj-meta">
                          출구까지 도보 {walk.distance ? `${walk.distance}m · ` : ""}
                          {walk.min}분 → {hhmm(arriveAt)} 도착
                        </span>
                      ) : (
                        <span className="vj-meta">도착</span>
                      )
                    ) : (
                      <>
                        {walk && (walk.min || walk.distance) ? (
                          <span className="vj-meta">
                            {walk.distance ? `도보 ${walk.distance}m · ` : "환승 통로 · "}
                            {walk.min || 0}분
                          </span>
                        ) : null}
                        {waitMin > 0 && <span className="vj-meta">환승 대기 {waitMin}분</span>}
                      </>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// 경로를 가로 막대 하나로 요약 (구간 길이는 소요시간에 비례)
function RouteFlow({
  rides,
  arriveAt,
}: {
  rides: { l: RouteLeg; start: number }[];
  arriveAt: number;
}) {
  if (!rides.length) return null;
  return (
    <div className="rf">
      <div className="rf-times">
        {rides.map(({ start }, k) => (
          <span key={k} style={{ flex: Math.max(1, rides[k].l.min || 1) }}>
            {hhmm(start)}
          </span>
        ))}
        <span className="rf-end">{hhmm(arriveAt)}</span>
      </div>
      <div className="rf-bar">
        {rides.map(({ l }, k) => (
          <span
            className="rf-seg"
            key={k}
            style={{ flex: Math.max(1, l.min || 1), background: l.color }}
          >
            <em>{l.line}</em>
            <b>{l.min}분</b>
          </span>
        ))}
      </div>
      <div className="rf-names">
        {rides.map(({ l }, k) => (
          <span key={k} style={{ flex: Math.max(1, l.min || 1), color: l.color }}>
            {l.start}
          </span>
        ))}
        <span className="rf-end">{rides[rides.length - 1].l.end}</span>
      </div>
    </div>
  );
}
