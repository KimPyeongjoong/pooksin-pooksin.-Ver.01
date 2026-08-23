"use client";

import { useState, useEffect } from "react";
import SchematicMap from "./SchematicMap";
import TimetableView from "./TimetableView";
import LiveTrainView from "./LiveTrainView";
import TrainStrip, { type TrainPos } from "./TrainStrip";
import {
  makeMockSeats,
  MOCK_ARRIVALS,
  REMAINING_STATIONS,
  LEDGER,
  type SeatState,
} from "@/lib/data";
import { searchStations, STATION_COUNT } from "@/lib/stations";
import { stationNeighbors, lineStations, linesAtStation, ALL_LINES } from "@/lib/lines";
import { DAY_LABEL, type DayType } from "@/lib/holidays";
import { carsForLeg } from "@/lib/car-counts";
import { lineColor, shortLine } from "@/lib/line-colors";
import { carLayout, allSeats, type Seat } from "@/lib/car-layout";
import CarDiagram from "./CarDiagram";

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
  stationID?: number | null; // (더 이상 쓰지 않음 — 예전 ODsay 호환 필드)
  wayCode?: number | null; // 1=상행/외선, 2=하행/내선
  transferMin?: number; // 앞 구간에서 이 구간으로 갈아탈 때 걸어가는 시간(분)
  waitMin?: number; // 승강장에서 기다리는 시간(분) — 공공 경로검색 API가 줍니다
  boardMin?: number; // 승차 시각(자정 기준 분) — API가 실제 열차 시각으로 줍니다
  arriveMin?: number; // 하차 시각
};

// 구간마다 몇 시에 타는지 계산합니다.
//
// **환승 시각은 그 역의 실제 시간표에서 찾습니다.**
//   앞 구간 도착 시각 + 환승 도보 시간 → 그 시각 이후 첫 열차.
// 그래야 "20:38에 7호선을 탄다"가 실제 있는 열차가 됩니다.
//
// 시간표를 못 받은 구간(자료 없는 노선 등)만 예전 방식으로 어림합니다 —
// 총 소요시간과 구간 시간 합의 차이(slack)를 환승 지점에 나눠 넣는 방식.
//
// 요약 시트와 상세 화면이 **같은 값**을 보여주도록 한곳에 둡니다.
export type LegTables = Map<string, { departures: Departure[] }>;
// 시간표를 찾는 열쇠: 역 + 노선 + 방향
export const legKey = (l: RouteLeg) => `${l.start ?? ""}|${l.line ?? ""}|${l.wayCode ?? 1}`;

// 역 이름 표기 차이 흡수 (앱의 다른 곳과 같은 규칙)
const bareName = (s: string) =>
  (s || "").replace(/\s/g, "").replace(/[·.]/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();

// "이 열차가 내릴 역까지 가는가"
//
// 중간에서 끝나는 열차가 많습니다 — 1호선 서동탄행·광명셔틀, 7호선 온수행처럼요.
// 그런 열차를 환승 열차로 골라버리면 "타도 못 가는 시각"이 됩니다.
// 행선지가 이 노선 목록에 없으면(다른 지선 등) 판단을 보류하고 그대로 둡니다 — 함부로 버리지 않습니다.
function reachesEnd(line: string, from: string, to: string) {
  if (/2호선/.test(line)) return () => true; // 순환선은 앞뒤를 번호로 못 가립니다
  const order = lineStations(line).map(bareName);
  const si = order.indexOf(bareName(from));
  const ei = order.indexOf(bareName(to));
  if (si < 0 || ei < 0 || si === ei) return () => true;
  const dir = Math.sign(ei - si);
  return (dest: string) => {
    const di = order.indexOf(bareName(dest));
    if (di < 0) return true;
    return Math.sign(di - si) === dir && Math.abs(di - si) >= Math.abs(ei - si);
  };
}

function legTiming(route: RouteData, departAt: number, tables?: LegTables) {
  const rideCount = route.legs.filter((l) => l.type === "subway").length;
  const legSum = route.legs.reduce((s, l) => s + (l.min || 0), 0);
  const transfers = Math.max(0, rideCount - 1);
  const slack = Math.max(0, (route.totalTime || 0) - legSum);
  const waitEach = transfers > 0 ? Math.floor(slack / transfers) : 0;
  const waitRest = transfers > 0 ? slack - waitEach * transfers : 0; // 나머지는 첫 환승에

  // ⭐ 공공 경로검색 API가 구간마다 **실제 열차 시각**을 줬으면 그걸 그대로 씁니다.
  //    (우리가 시간표를 뒤져 맞출 필요가 없습니다)
  const apiRides = route.legs.filter(
    (l) => l.type === "subway" && Number.isFinite(l.boardMin) && Number.isFinite(l.arriveMin)
  );
  if (apiRides.length && apiRides.length === route.legs.filter((l) => l.type === "subway").length) {
    const timedApi = route.legs.map((l, i) => ({ l, i, start: l.boardMin ?? departAt }));
    const last = apiRides[apiRides.length - 1];
    return {
      timed: timedApi,
      rides: timedApi.filter((x) => x.l.type === "subway"),
      arriveAt: last.arriveMin ?? departAt,
    };
  }

  let acc = departAt;
  let seenRides = 0;
  const timed = route.legs.map((l, i) => {
    if (l.type === "subway") {
      if (seenRides > 0) {
        // 환승: 앞 구간에서 내린 시각 + 걸어가는 시간
        const ready = acc + (l.transferMin ?? 0);
        const list = tables?.get(legKey(l))?.departures;
        // 급행 구간이면 급행 열차만, 완행 구간이면 완행만 봅니다
        // (완행 구간에 급행을 잡으면 내릴 역을 지나칠 수 있습니다)
        const kind = /\((급행|특급)\)$/.exec(l.line ?? "")?.[1] ?? "";
        const next = list?.find((d) => d.min >= ready && (kind ? d.ex === kind : !d.ex));
        // 시간표가 있으면 그 시각에 타고, 없으면 예전 방식(slack 나누기)으로 어림합니다
        acc = next ? next.min : acc + waitEach + (seenRides === 1 ? waitRest : 0);
      }
      seenRides++;
    }
    const start = acc;
    acc += l.min || 0;
    return { l, i, start };
  });
  // 시간표로 맞춘 경우 실제 도착이 엔진 추정보다 늦을 수 있습니다(다음 열차를 기다리므로).
  const arriveAt = tables?.size ? acc : Math.max(acc, departAt + (route.totalTime || 0));
  // 지하철 구간만 뽑되, 원래 순서(i)를 기억해 바로 뒤의 도보 구간을 찾을 수 있게 합니다.
  return { timed, rides: timed.filter((x) => x.l.type === "subway"), arriveAt };
}

// 출발역의 실제 시간표 (/api/timetable)
// ex 가 있으면 급행입니다 ("급행" 또는 "특급").
type Departure = { min: number; dest: string; ex?: string };
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
  const [pickedLine, setPickedLine] = useState<string | null>(null); // 도착정보 시트에서 고른 노선
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("station");
  const [query, setQuery] = useState("");

  // 경로검색
  const [routeOptions, setRouteOptions] = useState<RouteData[]>([]);
  const [routeErr, setRouteErr] = useState<string | null>(null);
  // 오류 성격: same=출발·도착 같음, retry=호출 몰림/네트워크, notFound=경로 없음
  const [routeErrKind, setRouteErrKind] = useState<string | null>(null);
  const [routeReload, setRouteReload] = useState(0); // "다시 시도" 누르면 증가
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeTab, setRouteTab] = useState<RouteTab>("time");
  const [departMin, setDepartMin] = useState<number | null>(null); // 시간표가 없을 때만 쓰는 대체 발차 시각(분)

  // 출발역 실제 시간표
  const [timetable, setTimetable] = useState<Timetable | null>(null);
  const [ttLoading, setTtLoading] = useState(false);
  const [depIdx, setDepIdx] = useState<number | null>(null); // 시간표에서 고른 열차 번호
  // 경로를 물어볼 기준 시각(자정 기준 분). null이면 "지금".
  // 공공 경로검색 API가 이 시각 이후로 탈 수 있는 열차로 답해줍니다.
  //
  // 어느 구간에 대한 시각인지 함께 담아둡니다 — 출발·도착이 바뀌면 저절로 "지금"으로 돌아갑니다.
  const [atPick, setAtPick] = useState<{ pair: string; min: number } | null>(null);
  const atPair = `${dep ?? ""}|${arr ?? ""}`;
  const atMin = atPick && atPick.pair === atPair ? atPick.min : null;
  const setAtMin = (min: number) => setAtPick({ pair: atPair, min });
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
  // "지금 열차 안이에요" 로 들어온 경우 (경로검색을 거치지 않은 진입)
  const [rideMode, setRideMode] = useState(false);
  const [rideOpen, setRideOpen] = useState(false); // 노선/방면 고르는 시트
  const [rideLine, setRideLine] = useState<string | null>(null);
  const [pickedTrain, setPickedTrain] = useState<TrainPos | null>(null); // 내가 탄 열차
  const [pickedCar, setPickedCar] = useState(3); // 내가 탄 칸

  const [points, setPoints] = useState(1240);
  const [revealed, setRevealed] = useState(false);
  const [pickedSeat, setPickedSeat] = useState<string | null>(null);
  const [alightFor, setAlightFor] = useState<string | null>(null); // 하차역을 입력할 좌석 id
  const [alightQuery, setAlightQuery] = useState(""); // 하차역 직접 검색어
  const [alightPicked, setAlightPicked] = useState<string | null>(null); // 검색으로 고른 역(등록 전)
  const [seats, setSeats] = useState<Record<string, SeatState>>({});
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
      setPickedLine(null); // 새 역이므로 노선 선택을 처음으로
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

  // 칸·좌석 화면에서 한 번에 첫 화면으로 나가기 (상단 오른쪽 ✕)
  //
  // ‹ 는 한 단계만 뒤로 가지만, ✕ 는 하던 것을 접고 노선도로 돌아갑니다.
  // 그래서 고르던 열차·칸과 경로검색 결과까지 함께 비웁니다.
  function exitToHome() {
    setView("home");
    setRideMode(false);
    setCarLeg(null);
    setPickedTrain(null);
    resetHome();
  }

  // "지금 열차 안이에요" — 경로검색 없이 바로 칸·좌석 화면으로 들어갑니다.
  // 노선과 방면만 정하면 나머지(현재 위치)는 상단 열차 스트립에서 열차를 고를 때 채워집니다.
  function startRide(line: string, towardLast: boolean) {
    const all = lineStations(line);
    if (!all.length) return;
    const ordered = towardLast ? all : [...all].reverse(); // 진행 방향 순서
    const terminus = ordered[ordered.length - 1];
    setCarLeg({
      type: "subway",
      line,
      color: lineColor(line),
      start: ordered[0], // 임시값 — 열차를 고르면 그 열차 위치로 바뀝니다
      end: terminus,
      stations: ordered,
      way: terminus,
      door: "",
      stationID: null,
      wayCode: null,
      stationCount: Math.max(1, ordered.length - 1),
      min: 0,
    });
    setRideMode(true);
    setRideOpen(false);
    setRideLine(null);
    setPickedTrain(null);
    setPickedCar(3);
    setView("car");
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

  // 출발·도착이 모두 정해지면 경로 계산 (직접 계산, 여러 후보)
  useEffect(() => {
    if (!dep || !arr) {
      setRouteOptions([]);
      setRouteErr(null);
      setRouteErrKind(null);
      setDepartMin(null);
      return;
    }
    // (출발·도착이 바뀌면 기준 시각은 아래 effect에서 "지금"으로 되돌립니다)
    setRouteLoading(true);
    setRouteOptions([]);
    setRouteErr(null);
    setRouteErrKind(null);
    // ⚠️ 출발 기준 시각을 함께 보냅니다.
    //    공공 경로검색 API가 "그 시각 이후로 탈 수 있는 열차"로 답해 주기 때문입니다.
    const q = new URLSearchParams({ from: dep, to: arr });
    if (atMin != null) q.set("at", String(atMin));
    fetch(`/api/route?${q}`)
      .then((r) => r.json())
      .then((d) => {
        setRouteOptions(d.options || []);
        setRouteErr(d.error || null);
        setRouteErrKind(d.kind || null);
        setDepartMin(nowMinutes()); // 발차 기본값 = 현재 시각
      })
      .catch(() => {
        setRouteErr("잠시 후 다시 시도해 주세요");
        setRouteErrKind("retry");
      })
      .finally(() => setRouteLoading(false));
  }, [dep, arr, routeReload, atMin]);

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
    const byName = !boardStationID && boardLeg?.start && boardLeg?.line;
    if (!boardStationID && !byName) {
      setTimetable(null);
      setDepIdx(null);
      return;
    }
    setTtLoading(true);
    setTimetable(null);
    setDepIdx(null);
    setPickedByUser(false);
    // 역 이름 + 노선을 보냅니다. 내장 시간표는 역 이름으로 찾기 때문입니다.
    // (stationID는 내장 시간표가 없는 노선에서 ODsay로 넘어갈 때만 쓰입니다)
    const q = new URLSearchParams();
    if (boardLeg?.start) q.set("station", boardLeg.start);
    if (boardLeg?.line) q.set("line", boardLeg.line);
    if (boardStationID) q.set("stationID", String(boardStationID));
    fetch(`/api/timetable?${q}`)
      .then((r) => r.json())
      .then((d: TimetableRes) => {
        const day = d.today ?? "weekday";
        const way = boardWayCode === 2 ? "down" : "up";
        // 내릴 역까지 가는 열차만 (중간에 끝나는 열차를 고르면 타도 못 갑니다)
        const ok = reachesEnd(boardLeg?.line ?? "", boardLeg?.start ?? "", boardLeg?.end ?? "");
        const departures = (d.lists?.[day]?.[way] ?? []).filter((t) => ok(t.dest));
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
  }, [boardStationID, boardWayCode, boardLeg?.start, boardLeg?.line, boardLeg?.end]);

  // 환승역 시간표 — 환승 시각을 **실제 열차**에 맞추려고 구간마다 미리 받아둡니다.
  // 앞 구간 도착 + 환승 도보 시간 뒤에 오는 첫 열차를 찾는 데 씁니다.
  // (한 경로에 보통 1~3개고, 내장 자료라 외부 API 호출은 없습니다)
  const [legTables, setLegTables] = useState<LegTables>(new Map());
  const rideKeys = route
    ? route.legs.filter((l) => l.type === "subway").map(legKey).join(";")
    : "";
  useEffect(() => {
    if (!route) {
      setLegTables(new Map());
      return;
    }
    const legs = route.legs.filter((l) => l.type === "subway");
    let alive = true;
    Promise.all(
      legs.map(async (l) => {
        const q = new URLSearchParams();
        if (l.start) q.set("station", l.start);
        if (l.line) q.set("line", l.line);
        try {
          const d: TimetableRes = await (await fetch(`/api/timetable?${q}`)).json();
          const day = d.today ?? "weekday";
          const way = l.wayCode === 2 ? "down" : "up";
          // 이 구간에서 내릴 역까지 가는 열차만 남깁니다 (중간에 끝나는 열차 제외)
          const ok = reachesEnd(l.line ?? "", l.start ?? "", l.end ?? "");
          const departures = (d.lists?.[day]?.[way] ?? []).filter((t) => ok(t.dest));
          return departures.length ? ([legKey(l), { departures }] as const) : null;
        } catch {
          return null;
        }
      })
    ).then((rows) => {
      if (!alive) return;
      setLegTables(new Map(rows.filter((r) => r !== null)));
    });
    return () => {
      alive = false;
    };
    // route 자체가 아니라 "구간 목록"이 바뀔 때만 다시 받습니다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideKeys]);

  // 지금 출발해서 탈 수 있는 첫 열차 (도보 이동 시간 감안)
  //
  // 공공 경로검색 API가 답한 경로라면 **API가 고른 열차**에 맞춥니다.
  // (안 맞추면 위쪽 발차 선택기는 23:41, 경로는 23:51 처럼 따로 놉니다)
  const firstBoardIdx = (() => {
    if (!timetable?.departures.length) return 0;
    const apiBoard = route?.legs.find((l) => l.type === "subway")?.boardMin;
    if (apiBoard != null) {
      const j = timetable.departures.findIndex((d) => d.min === apiBoard);
      if (j >= 0) return j;
    }
    const i = timetable.departures.findIndex((d) => d.min >= nowMin + preBoardMin);
    return i < 0 ? timetable.departures.length - 1 : i; // 오늘 남은 열차가 없으면 막차
  })();
  const noMoreToday =
    !!timetable?.departures.length &&
    timetable.departures[timetable.departures.length - 1].min < nowMin + preBoardMin;

  // 시간표가 준비되면 다음 열차를 자동 선택합니다.
  // 사용자가 직접 고른 뒤에는 건드리지 않습니다 — 지나간 열차를 일부러 보고 있을 수도
  // 있어서(‹ 이전), 시간이 흐른다고 앞으로 밀어버리면 안 됩니다.
  useEffect(() => {
    if (!timetable) return;
    setDepIdx((cur) => (!pickedByUser || cur == null ? firstBoardIdx : cur));
  }, [timetable, pickedByUser, firstBoardIdx]);

  // 실제 발차 시각 (시간표가 없으면 기존 방식으로 대체)
  const picked = timetable && depIdx != null ? timetable.departures[depIdx] : null;
  const boardAt = picked ? picked.min : (departMin ?? nowMin) + preBoardMin;
  // RouteDetail은 "여정 시작 시각"부터 구간을 누적하므로 도보 시간만큼 앞당겨 넘깁니다.
  const journeyStart = boardAt - preBoardMin;
  // 구간별 시각 (환승은 그 역 실제 시간표에서 찾은 열차 기준) — 요약·상세가 같이 씁니다
  const timing = route ? legTiming(route, journeyStart, legTables) : null;
  // 공공 경로검색 API가 답한 경로는 **첫 열차 시각도 API가 정합니다.**
  // 머리말(출발~도착)과 막대의 시각이 어긋나지 않도록 그 값을 기준으로 삼습니다.
  const firstRideStart = timing?.rides?.[0]?.start;
  const journeyStartEff =
    firstRideStart != null && Number.isFinite(firstRideStart)
      ? firstRideStart - preBoardMin
      : journeyStart;

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

  // 이 칸의 실제 좌석 배치 (진행 방향 기준)
  const seatLayout = carLayout(carLeg?.line ?? "", carInfo.cars);

  // 이 구간에서 승차역 다음부터 하차역까지 지나갈 역들
  const legStations = (carLeg?.stations ?? []).filter((n) => n !== carLeg?.start);
  // 이 구간의 하차역 (환승이면 갈아타는 역, 마지막 구간이면 최종 도착역)
  const legEnd = carLeg?.end ?? null;
  // 최종 목적지가 아니면 환승역입니다
  const isTransfer = !!legEnd && !!arr && legEnd !== arr;

  // 하차역 직접 검색은 "이 호선 전체"를 대상으로 합니다.
  // (경로에 없는 역이라도 같은 호선이면 내릴 수 있으니까요)
  const lineAllStations = lineStations(carLeg?.line ?? "");
  const alightMatches = alightQuery.trim()
    ? lineAllStations.filter((n) => n !== carLeg?.start && n.includes(alightQuery.trim())).slice(0, 20)
    : [];

  // 승차역에서 몇 정거장인지 (노선 위 순서로 계산)
  function stopsTo(station: string): number {
    const a = lineAllStations.indexOf(carLeg?.start ?? "");
    const b = lineAllStations.indexOf(station);
    if (a < 0 || b < 0) return Math.max(1, legStations.indexOf(station) + 1);
    return Math.max(1, Math.abs(b - a));
  }

  // 칸이 바뀌면 그 칸의 좌석을 새로 채웁니다 (지금은 목업, 나중에 서버 데이터로 교체)
  useEffect(() => {
    setSeats(
      makeMockSeats(
        allSeats(seatLayout).map((x) => x.id),
        `${carLeg?.line ?? ""}-${pickedCar}`,
        legStations
      )
    );
    setPickedSeat(null);
    setAlightFor(null);
    setRevealed(false);
  }, [carLeg?.line, carInfo.cars, pickedCar]);

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
      // 이미 떠난 열차도 볼 수 있습니다(놓친 열차 확인용).
      const next = Math.min(timetable.departures.length - 1, Math.max(0, cur + delta));
      // 고른 열차 시각으로 경로를 다시 물어봅니다
      // (그 열차 기준으로 환승 시각·도착 시각이 다시 맞춰집니다)
      const pick = timetable.departures[next];
      if (pick) setAtMin(pick.min);
      return next;
    });
  }

  const regCount = Object.values(seats).filter((s) => s.kind === "occupied").length;
  // 도착정보 시트에서 보고 있는 노선.
  //
  // 환승역은 여러 노선이 지나가서, 예전에는 모든 노선의 방면이 한꺼번에 나열돼
  // 무엇이 무엇인지 알기 어려웠습니다. 이제 노선을 하나 골라 그 노선의 두 방향만 봅니다.
  const stationLines = selectedStation ? linesAtStation(selectedStation) : [];
  const sheetLine = pickedLine ?? stationLines[0]?.label ?? null;
  const neighbors = selectedStation ? stationNeighbors(selectedStation, sheetLine) : null;
  // 고른 노선의 방면만 (환승역이면 다른 노선 방면은 감춥니다)
  const sheetGroups = (arrivals?.groups ?? []).filter(
    (g) => !sheetLine || shortLine(g.line) === shortLine(sheetLine)
  );

  // 지도 포커스: 출발~도착 사이 "구간"만 강조 + 경로 위 역만 진하게
  const routeLegs = route ? route.legs.filter((l) => l.type === "subway") : [];
  const routeStations = Array.from(new Set(routeLegs.flatMap((l) => l.stations || [])));
  const mapFocus =
    dep && arr && route && routeLegs.length
      ? {
          dep,
          arr,
          stations: routeStations,
          // stations(그 구간이 지나는 역 목록)까지 넘겨야 지선을 정확히 칠할 수 있습니다.
          // 예: 2호선 성수→신설동은 성수지선인데, 역 이름만으로는 본선 쪽을 칠할 수 있습니다.
          legs: routeLegs.map((l) => ({
            line: l.line || "",
            start: l.start || "",
            end: l.end || "",
            stations: l.stations || [],
          })),
        }
      : null;

  // 좌석 클릭 (빈 좌석 → 하차역 입력 모달)
  function tapSeat(seat: Seat) {
    if (seats[seat.id]?.kind === "occupied") return;
    setPickedSeat(seat.id);
    setAlightFor(seat.id);
    setAlightQuery("");
    setAlightPicked(null);
  }

  // 하차역 선택 → 등록(공급) → 포인트 적립
  function registerAlight(stationName: string, stopsLeft: number) {
    if (!alightFor) return;
    setSeats((prev) => ({ ...prev, [alightFor]: { kind: "occupied", station: stationName, stopsLeft } }));
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
                      disabled={timetable ? (depIdx ?? 0) <= 0 : false}
                    >
                      ‹ 이전
                    </button>
                    <button className="mid" style={{ lineHeight: 1.25 }}>
                      {ttLoading ? (
                        "시간표 확인 중…"
                      ) : (
                        <>
                          <span>
                            {boardAt >= 1440 ? "내일 " : ""}
                            {fmtAmPm(boardAt)}
                          </span>
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
                setPickedLine(null);
                setStage("station");
              }}
              selected={selectedStation}
              popoverOpen={stage === "station"}
              focus={mapFocus}
              onStart={chooseStart}
              onEnd={chooseEnd}
              onWaypoint={() => showToast("경유지 추가는 추후 지원")}
              onTimetable={() => selectedStation && openTimetable(selectedStation, sheetLine)}
              onLive={() => selectedStation && openLive(selectedStation, sheetLine)}
              onEmptyClick={() => stage === "station" && setStage("map")}
            />
          ) : (
            <RouteDetail
              route={route}
              departAt={journeyStartEff}
              tables={legTables}
              boardAt={boardAt}
              nowMin={nowMin}
              onBoard={(leg) => {
                setCarLeg(leg);
                setRideMode(false);
                setPickedTrain(null); // 구간이 바뀌면 열차도 다시 고릅니다
                setView("car");
              }}
            />
          )}

          {/* 지도 위 FAB (깨끗한 홈에서만) */}
          {stage === "map" && !dep && !arr && (
            <>
              <button className="fab ride" onClick={() => setRideOpen(true)}>
                <span className="ride-ic" /> 지금 열차 안이에요
              </button>
              <button className="fab round" style={{ right: 14, bottom: 78 }}>
                ◎
              </button>
            </>
          )}

          {/* "지금 열차 안이에요" — 노선 → 방면 고르기 */}
          {rideOpen && (
            <>
              <div className="overlay-scrim" onClick={() => { setRideOpen(false); setRideLine(null); }} />
              <div className="sheet ride-sheet">
                <div className="grab" />
                {!rideLine ? (
                  <>
                    <h3 className="ride-h">어느 노선에 타고 계세요?</h3>
                    <div className="ride-lines">
                      {ALL_LINES.filter((l) => lineStations(l.label).length > 1).map((l) => (
                        <button
                          key={l.label}
                          className="ride-line"
                          style={{ borderColor: lineColor(l.label) }}
                          onClick={() => setRideLine(l.label)}
                        >
                          <em style={{ background: lineColor(l.label) }}>{l.indicator}</em>
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <button className="ride-back" onClick={() => setRideLine(null)}>‹ 노선 다시 고르기</button>
                    <h3 className="ride-h">
                      <span className="vj-line" style={{ background: lineColor(rideLine) }}>{rideLine}</span>
                      어느 방향으로 가고 있나요?
                    </h3>
                    <div className="ride-ways">
                      {[true, false].map((towardLast) => {
                        const all = lineStations(rideLine);
                        const ordered = towardLast ? all : [...all].reverse();
                        const terminus = ordered[ordered.length - 1];
                        const from = ordered[0];
                        return (
                          <button
                            key={String(towardLast)}
                            className="ride-way"
                            onClick={() => startRide(rideLine, towardLast)}
                          >
                            <b>{withYeok(terminus)} 방면</b>
                            <small>{from} → {terminus}</small>
                          </button>
                        );
                      })}
                    </div>
                    <p className="ride-hint">
                      방면을 고르면 지금 달리는 열차 중에서 탄 열차를 고를 수 있어요
                    </p>
                  </>
                )}
              </div>
            </>
          )}

          {/* 역 클릭: 팝오버 + 도착정보 시트 */}
          {stage === "station" && (
            <>
              {/* 투명막(overlay-scrim)을 두지 않습니다 — 팝오버가 떠 있는 동안에도
                  지도를 끌고 확대할 수 있어야 해서, 닫기는 지도 빈 곳 클릭으로 처리합니다. */}
              <div className="sheet">
                <div className="grab" />

                {/* 이 역이 지나는 노선 고르기 (환승역이면 여러 개) */}
                {stationLines.length > 1 && (
                  <div className="st-lines">
                    {stationLines.map((l) => (
                      <button
                        key={l.label}
                        className={`st-linebtn${l.label === sheetLine ? " on" : ""}`}
                        style={
                          l.label === sheetLine
                            ? { background: l.color, borderColor: l.color, color: "#fff" }
                            : { borderColor: l.color, color: l.color }
                        }
                        onClick={() => setPickedLine(l.label)}
                      >
                        {l.indicator}
                      </button>
                    ))}
                  </div>
                )}

                <div className="st-step">
                  <button
                    className="st-side left"
                    disabled={!neighbors?.prev}
                    onClick={() => {
                      if (!neighbors?.prev) return;
                      setPickedLine(sheetLine); // 같은 노선을 따라 이동
                      setSelectedStation(neighbors.prev);
                    }}
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
                    onClick={() => {
                      if (!neighbors?.next) return;
                      setPickedLine(sheetLine);
                      setSelectedStation(neighbors.next);
                    }}
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
                      {(MOCK_ARRIVALS.filter((g) => shortLine(g.line) === shortLine(sheetLine ?? "")).length
                        ? MOCK_ARRIVALS.filter((g) => shortLine(g.line) === shortLine(sheetLine ?? ""))
                        : MOCK_ARRIVALS
                      ).map((g, i) => (
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

                {!arrLoading && arrivals && arrivals.groups.length > 0 && sheetGroups.length === 0 && (
                  <div style={{ padding: "16px 2px", color: "var(--muted)", fontSize: 12.5, lineHeight: 1.6, fontWeight: 600 }}>
                    {sheetLine}의 실시간 도착 정보는 제공되지 않아요.
                    <br />
                    <span style={{ color: "var(--faint)", fontWeight: 550 }}>
                      아래 “전체 시간표”로 확인할 수 있습니다.
                    </span>
                  </div>
                )}

                {!arrLoading && arrivals && sheetGroups.length > 0 && (
                  <div className="arrcards" style={{ maxHeight: 240, overflowY: "auto" }}>
                    {sheetGroups.map((g, i) => (
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
                {/* 소요시간·도착시각은 아래 막대와 같은 계산(실제 환승 열차 시간표)을 씁니다.
                    환승 대기가 길면 그만큼 늘어납니다 — 실제로 그렇게 걸리니까요. */}
                <div className="rs-head">
                  <span className="dur">{(timing?.arriveAt ?? journeyStartEff) - journeyStartEff}분</span>
                  <span className="sub">
                    {fmtAmPm(journeyStartEff)} – {fmtAmPm(timing?.arriveAt ?? journeyStartEff)} · 환승 {route.transferCount}회{route.payment ? ` · ${route.payment.toLocaleString()}원` : ""}
                  </span>
                </div>
                {/* 한눈에 보는 막대: 위에 승차 시각, 안에 노선·소요시간, 회색 칸에 환승 도보,
                    아래에 역 이름(출발·환승·도착). 세 줄이 같은 flex 값을 써서 세로로 맞습니다. */}
                {(() => {
                  const rides = timing?.rides ?? [];
                  // 막대 한 칸씩: 열차 구간과 그 사이 회색 환승 칸
                  const cells = rides.flatMap(({ l, start }, i) => {
                    const out: {
                      kind: "ride" | "walk";
                      flex: number;
                      leg: RouteLeg;
                      start: number;
                    }[] = [{ kind: "ride", flex: Math.max(1.2, l.stationCount || 1), leg: l, start }];
                    const next = rides[i + 1];
                    if (next)
                      out.push({
                        kind: "walk",
                        flex: 0.9,
                        leg: next.l,
                        start: next.start,
                      });
                    return out;
                  });
                  return (
                    <div className="segwrap">
                      <div className="seg-times">
                        {cells.map((c, i) => (
                          <span key={i} style={{ flex: c.flex }}>
                            {c.kind === "ride" ? hhmm(c.start) : ""}
                          </span>
                        ))}
                      </div>
                      <div className="segbar">
                        {cells.map((c, i) =>
                          c.kind === "ride" ? (
                            <span key={i} className="seg" style={{ flex: c.flex, background: c.leg.color }}>
                              <small>{c.leg.line}</small>
                              <small className="segmin">{c.leg.min}분</small>
                            </span>
                          ) : (
                            <span key={i} className="seg walk" style={{ flex: c.flex }}>
                              {/* 환승 도보 시간 — 서울교통공사 환승정보에서 온 실제 값 */}
                              <small>{c.leg.transferMin ?? 3}분</small>
                            </span>
                          )
                        )}
                      </div>
                      <div className="seg-names">
                        {cells.map((c, i) => (
                          <span key={i} style={{ flex: c.flex }}>
                            {c.kind === "ride" ? withYeok(c.leg.start || "") : ""}
                          </span>
                        ))}
                        <span className="seg-arr">{withYeok(arr || "")}</span>
                      </div>
                    </div>
                  );
                })()}
                <div style={{ textAlign: "center", color: "var(--faint)", fontSize: 11, marginTop: 12 }}>
                  ▲ 눌러서 상세 경로 보기
                </div>
              </div>
            ) : (
              <div className="sheet">
                <div className="grab" />
                <div className="route-err">
                  <b>{routeErr ?? "경로를 찾지 못했어요"}</b>
                  {routeErrKind === "same" && <small>다른 역을 골라주세요</small>}
                  {routeErrKind === "quota" && (
                    <small>
                      경로검색은 하루에 쓸 수 있는 횟수가 정해져 있어요.
                      <br />
                      내일 다시 쓸 수 있습니다 (다시 시도해도 소용없어요).
                    </small>
                  )}
                  {routeErrKind === "retry" && (
                    <>
                      <small>일시적으로 연결이 불안정합니다</small>
                      <button className="err-retry" onClick={() => setRouteReload((n) => n + 1)}>
                        다시 시도
                      </button>
                    </>
                  )}
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
                setPickedLine(null);
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
            <button className="appbar-x" onClick={exitToHome} aria-label="홈으로">
              ✕
            </button>
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
                onSelect={(t) => {
                  setPickedTrain(t);
                  // 탑승 모드에서는 고른 열차의 현재 위치가 곧 내 위치입니다
                  if (rideMode && t?.station) {
                    setCarLeg((prev) => (prev && prev.start !== t.station ? { ...prev, start: t.station } : prev));
                  }
                }}
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
            <button className="appbar-x" onClick={exitToHome} aria-label="홈으로">
              ✕
            </button>
          </div>
          {/* 칸 이동: ‹ 이전 칸 · [n번 칸 ▾] · 다음 칸 › */}
          <div className="carnav">
            <button
              className="carnav-arrow"
              onClick={() => setPickedCar((c) => Math.max(1, c - 1))}
              disabled={pickedCar <= 1}
              aria-label="이전 칸"
            >
              ‹
            </button>
            <div className="carnav-pick">
              <select
                value={pickedCar}
                onChange={(e) => setPickedCar(Number(e.target.value))}
                aria-label="칸 선택"
              >
                {carOrder.map((n) => (
                  <option key={n} value={n}>
                    {n}번 칸
                  </option>
                ))}
              </select>
              <span className="carnav-label">
                {pickedCar}번 칸
                <i className="carnav-caret" />
              </span>
            </div>
            <button
              className="carnav-arrow"
              onClick={() => setPickedCar((c) => Math.min(carInfo.cars, c + 1))}
              disabled={pickedCar >= carInfo.cars}
              aria-label="다음 칸"
            >
              ›
            </button>
          </div>

          <div className="scroll pad">
            <div className="cd-sum">
              이 칸에 하차역이 등록된 좌석 <b>{regCount}개</b>
            </div>

            <CarDiagram
              layout={seatLayout}
              seats={seats}
              pickedSeat={pickedSeat}
              revealed={revealed}
              onTap={tapSeat}
            />

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
                <h3>
                  {rideMode
                    ? "어디서 내리시나요?"
                    : `${legEnd ? withYeok(legEnd) : "어느 역"}에서 ${isTransfer ? "환승" : "하차"}하시나요?`}
                </h3>
                <p className="sub">등록하면 +15P가 적립됩니다</p>

                {!rideMode && legEnd && (
                  <button
                    className="btn alight-main"
                    onClick={() => registerAlight(legEnd, legStations.length)}
                  >
                    {withYeok(legEnd)} 하차 등록
                  </button>
                )}

                {/* 그 역에서 안 내리는 경우: 같은 호선의 다른 역을 직접 검색 */}
                <div className={`alight-other${rideMode ? " bare" : ""}`}>
                  <div className={`alight-field${alightPicked ? " has-pick" : ""}`}>
                    {alightPicked ? (
                      <span className="alight-chip">
                        {withYeok(alightPicked)}
                        <button
                          className="alight-x"
                          onClick={() => {
                            setAlightPicked(null);
                            setAlightQuery("");
                          }}
                          aria-label="선택 취소"
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <input
                        className="alight-input"
                        placeholder="하차역 입력하기"
                        value={alightQuery}
                        onChange={(e) => setAlightQuery(e.target.value)}
                      />
                    )}
                    {alightPicked && (
                      <button
                        className="alight-go"
                        onClick={() => registerAlight(alightPicked, stopsTo(alightPicked))}
                      >
                        하차등록
                      </button>
                    )}
                  </div>

                  {/* 자동완성: 누르면 등록이 아니라 위 칸에 선택으로 들어갑니다 */}
                  {!alightPicked && alightQuery.trim() && (
                    <div className="stn-list" style={{ marginTop: 8, maxHeight: 220, overflowY: "auto" }}>
                      {alightMatches.map((n) => (
                        <button
                          className="stn-item"
                          key={n}
                          onClick={() => {
                            setAlightPicked(n);
                            setAlightQuery(n);
                          }}
                        >
                          <span>{withYeok(n)}</span>
                        </button>
                      ))}
                      {alightMatches.length === 0 && (
                        <div className="alight-none">
                          {carLeg?.line ?? "이 호선"}만 하차 등록 가능합니다.
                        </div>
                      )}
                    </div>
                  )}
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

// 상세 경로의 각 승차역에 붙는 "곧 오는 열차" 박스.
//
// **실시간 기준**입니다. 서버(/api/next-trains)가 이렇게 만듭니다.
//   ① 서울시 실시간 열차위치로 이 역 쪽으로 오고 있는 열차를 고르고
//   ② 앱에 내장된 구간 소요시간으로 여기까지 걸릴 시간을 계산합니다 (**지연이 그대로 반영**됩니다)
//   ③ 도착정보에 남은 시간이 있으면 그 값을 씁니다
//   ④ 모자라거나 실시간이 없는 노선이면 내장 시간표로 채웁니다
//
// 환승이 있으면 구간마다 역·방향이 다르므로 구간별로 각자 불러옵니다.
type NextTrain = {
  source: "live" | "timetable";
  etaSec: number | null; // 실시간일 때만: 도착까지 남은 초
  min: number; // 자정 기준 분 (화면에 찍는 시각)
  dest: string;
  express: boolean;
  from?: string; // 그 열차가 지금 있는 역
  stops?: number; // 몇 정거장 전
  last?: boolean;
};

function LegBoard({ leg, nowMin }: { leg: RouteLeg; nowMin: number }) {
  const [trains, setTrains] = useState<NextTrain[] | null>(null);
  const [loading, setLoading] = useState(true);

  const line = leg.line || "";
  const start = leg.start || "";
  const end = leg.end || "";
  const wayCode = leg.wayCode ?? null;
  // 경로 결과의 노선 이름이 "1호선(급행)"이면 이 구간은 급행을 타는 구간입니다.
  const expressKind = /((급행|특급))$/.exec(line)?.[1] ?? "";

  useEffect(() => {
    if (!start || !line) return;
    let alive = true;
    const load = () => {
      const q = new URLSearchParams({ station: start, line });
      if (end) q.set("to", end); // 진행 방향을 알아내는 데 씁니다
      if (wayCode) q.set("way", String(wayCode));
      fetch(`/api/next-trains?${q}`)
        .then((r) => r.json())
        .then((d: { trains?: NextTrain[] }) => {
          if (!alive) return;
          setTrains(d.trains ?? []);
        })
        .catch(() => alive && setTrains([]))
        .finally(() => alive && setLoading(false));
    };
    load();
    // 20초마다 다시 받습니다 (서버가 15초 캐시를 쓰므로 서울시 API 호출량은 늘지 않습니다)
    const id = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [start, end, line, wayCode]);

  if (loading) return <span className="lb-wait">곧 오는 열차 확인 중…</span>;
  if (!trains?.length)
    return (
      <span className="lb">
        <span className="lb-row lb-none">
          {expressKind ? `오늘 남은 ${expressKind}이 없어요` : "오늘 남은 열차가 없어요"}
        </span>
      </span>
    );

  return (
    <span className="lb">
      {trains.map((t, i) => {
        // 실시간이면 도착까지 남은 시간을 그대로 쓰고, 시간표면 지금 시각과의 차이로 셉니다.
        const left = t.etaSec != null ? Math.max(0, Math.round(t.etaSec / 60)) : t.min - nowMin;
        return (
          <span className="lb-row" key={i}>
            <b>{hhmm(t.min)}</b>
            <em>{left <= 0 ? "곧 도착" : `${left}분`}</em>
            {/* 어디서 온 값인지 숨기지 않습니다 — 실시간이면 지금 어느 역에 있는지도 알려줍니다 */}
            {t.source === "live" ? (
              <em className="lb-tag live" title={t.from ? `${t.from} ${t.stops}정거장 전` : ""}>
                실시간
              </em>
            ) : (
              <em className="lb-tag">시간표</em>
            )}
            {t.express && <em className="tt-badge exp">{expressKind || "급행"}</em>}
            <span className="lb-dest">{t.dest ? `${t.dest}행` : ""}</span>
          </span>
        );
      })}
    </span>
  );
}

function RouteDetail({
  route,
  departAt,
  tables,
  boardAt,
  nowMin,
  onBoard,
}: {
  route: RouteData | null;
  departAt: number; // 여정 시작(도보 포함) 시각
  tables: LegTables; // 구간별 시간표 (환승 시각을 실제 열차에 맞추는 데 씁니다)
  boardAt: number; // 첫 열차 발차 시각
  nowMin: number; // 지금 시각 (30초마다 갱신)
  onBoard: (leg: RouteLeg) => void; // 그 노선의 탑승 칸 선택으로 이동
}) {
  if (!route || route.error || !route.legs.some((l) => l.type === "subway")) {
    return (
      <div className="scroll pad" style={{ background: "var(--surface)", color: "var(--muted)", fontSize: 13 }}>
        경로를 불러오지 못했어요{route?.error ? ` (${route.error})` : ""}.
      </div>
    );
  }
  // 구간별 시각은 요약 시트와 같은 계산을 씁니다 (legTiming 참고)
  const { timed, rides, arriveAt } = legTiming(route, departAt, tables);

  return (
    <div className="scroll" style={{ background: "var(--surface)" }}>
      <div className="pad">
        <div className="dj-head">
          {/* 아래 시각들과 같은 계산 — 환승 열차를 실제 시간표에서 찾으므로 대기가 길면 그만큼 늘어납니다 */}
          <div className="dur">{arriveAt - departAt}분</div>
          <div className="sub">
            {fmtAmPm(departAt)} – {fmtAmPm(arriveAt)}{route.payment ? ` · ${route.payment.toLocaleString()}원` : ""}
          </div>
          <div className="dj-note">환승 {route.transferCount}회 · {route.stationCount}정거장 · 선택 발차 기준</div>
        </div>

        {/* 한눈에 보는 일직선 경로 */}
        <RouteFlow rides={rides} arriveAt={arriveAt} nowMin={nowMin} boardAt={boardAt} />

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
                      <span className="vj-sub">빠른 환승: {quickTransfer(l.door)}</span>
                    )}
                    {/* 이 역에서 곧 떠나는 열차 + 지금 어디쯤 오고 있는지 */}
                    <LegBoard leg={l} nowMin={nowMin} />
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
                        {/* 걸어가는 시간과 승강장에서 기다리는 시간을 나눠서 보여줍니다 */}
                        {waitMin > 0 &&
                          (() => {
                            const walkMin = nextRide?.l.transferMin ?? 0;
                            const idle = Math.max(0, waitMin - walkMin);
                            return (
                              <span className="vj-meta">
                                {walkMin > 0 ? `환승 도보 ${walkMin}분` : "환승"}
                                {idle > 0 ? ` · 대기 ${idle}분` : ""}
                              </span>
                            );
                          })()}
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
  nowMin,
  boardAt,
}: {
  rides: { l: RouteLeg; start: number }[];
  arriveAt: number;
  nowMin: number; // 지금 시각
  boardAt: number; // 고른 열차의 발차 시각
}) {
  if (!rides.length) return null;
  // "지금부터 몇 분 뒤에 떠나는 열차인지" — 지나간 열차를 고르면 음수가 됩니다.
  const diff = boardAt - nowMin;
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
      {/* 고른 열차가 지금으로부터 얼마나 남았는지 */}
      <div className="rf-now">
        {fmtAmPm(nowMin)} 기준
        {diff > 0 ? ` · ${diff}분 뒤 출발` : diff === 0 ? " · 지금 출발" : ` · ${-diff}분 전에 떠난 열차`}
      </div>
    </div>
  );
}
