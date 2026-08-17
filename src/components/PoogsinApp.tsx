"use client";

import { useState, useEffect } from "react";
import SchematicMap from "./SchematicMap";
import {
  CAR_SEATS,
  MOCK_ARRIVALS,
  REMAINING_STATIONS,
  LEDGER,
  type SeatState,
} from "@/lib/data";
import { searchStations, STATION_COUNT } from "@/lib/stations";
import { stationNeighbors } from "@/lib/lines";

// 화면(뷰) 종류
type View = "home" | "car" | "seat";
// 홈 탭 내부 단계
type Stage = "map" | "station" | "detail";
// 검색 오버레이가 무엇을 고르는지
type SearchMode = "station" | "dep" | "arr";
// 하단 탭
type Tab = "home" | "wallet";

// 실시간 도착정보(서버 경로에서 받아오는 모양)
type ArrivalGroup = { line: string; dir: string; trains: { msg: string; sec: number }[] };
type Arrivals = { source: string; updatedAt: string; groups: ArrivalGroup[] };

// 경로검색 결과
type RouteLeg = {
  type: string; line?: string; color?: string; start?: string; end?: string;
  stationCount?: number; min?: number; way?: string; door?: string; distance?: number;
};
type RouteData = {
  from?: string; to?: string; totalTime?: number; payment?: number;
  transferCount?: number; stationCount?: number; legs: RouteLeg[]; error?: string;
};
type RouteTab = "time" | "transfer" | "fare" | "last";

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
      })
      .catch(() => setRouteErr("네트워크 오류"))
      .finally(() => setRouteLoading(false));
  }, [dep, arr]);

  // 탭 기준으로 고른 현재 경로
  const route = pickRoute(routeOptions, routeTab);

  const regCount = seats.top.concat(seats.bottom).filter((s) => s.kind === "occupied").length;
  const neighbors = selectedStation ? stationNeighbors(selectedStation) : null;

  // 지도 포커스: 출발·도착·경로가 정해지면 그 경로 노선만 강조
  const routeLines = route
    ? Array.from(new Set(route.legs.filter((l) => l.type === "subway").map((l) => l.line || "")))
        .filter(Boolean)
    : [];
  const mapFocus =
    dep && arr && route && routeLines.length ? { dep, arr, lines: routeLines } : null;

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
      <StatusBar time={view === "seat" || stage === "detail" ? "8:21" : "8:24"} />

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
                {dep && arr && (
                  <div className="tabs" style={{ marginTop: 8, borderTop: "1px solid var(--line-2)", borderRadius: 12 }}>
                    <button className={routeTab === "time" ? "on" : ""} onClick={() => setRouteTab("time")}>최단시간</button>
                    <button className={routeTab === "transfer" ? "on" : ""} onClick={() => setRouteTab("transfer")}>최소환승</button>
                    <button className={routeTab === "fare" ? "on" : ""} onClick={() => setRouteTab("fare")}>최저요금</button>
                    <button
                      className={routeTab === "last" ? "on" : ""}
                      onClick={() => { setRouteTab("last"); showToast("막차 기준은 시간표 연동 후 제공됩니다"); }}
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
              onTimetable={() => showToast("전체 시간표는 추후 연결")}
            />
          ) : (
            <RouteDetail route={route} from={dep} to={arr} onBoard={() => setView("car")} />
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
                        <div className="arrcard" key={i}>
                          <div className="dst">
                            <span>{g.line} · {g.dir}</span>
                          </div>
                          {g.trains.map((t, j) => (
                            <div className="t2" key={j}>
                              <span>{j === 0 ? "이번" : "다음"}</span>
                              <em>{t.msg}</em>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {!arrLoading && arrivals && arrivals.groups.length > 0 && (
                  <div className="arrcards" style={{ maxHeight: 240, overflowY: "auto" }}>
                    {arrivals.groups.map((g, i) => (
                      <div className="arrcard" key={i}>
                        <div className="dst">
                          <span>
                            {g.line} · {g.dir}
                          </span>
                        </div>
                        {g.trains.map((t, j) => (
                          <div className="t2" key={j}>
                            <span>{j === 0 ? "이번" : "다음"}</span>
                            <em>{t.msg}</em>
                          </div>
                        ))}
                      </div>
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
                    환승 {route.transferCount}회 · {route.payment?.toLocaleString()}원 · {route.stationCount}정거장
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

      {/* ====================== 칸 선택 ====================== */}
      {view === "car" && (
        <div className="view">
          <div className="appbar">
            <button className="back" onClick={() => setView("home")}>
              ‹
            </button>
            탑승한 칸 선택
          </div>
          <div className="scroll pad">
            <p className="platform-hint">지금 서 계신 승강장 칸을 눌러주세요</p>
            <div className="dirflow">
              <span>신도림 방면</span>
              <span className="arrowline" />
            </div>
            <div className="train">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <div className={`car ${n === 3 ? "sel" : ""} ${n === 5 || n === 8 ? "tip" : ""}`} key={n}>
                  {n}
                  <small>{n === 3 ? "여기" : n === 5 ? "약냉방" : n === 8 ? "빠른환승" : "일반"}</small>
                </div>
              ))}
            </div>
            <div className="infobox">
              <b style={{ color: "var(--ink)" }}>3번 칸</b> 선택됨 · 부평구청 <b style={{ color: "var(--good)" }}>빠른 환승</b>은 8번 칸이 유리합니다.
            </div>
          </div>
          <div className="sticky-cta">
            <button className="btn" onClick={() => setView("seat")}>
              3번 칸 좌석 보기 →
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
            3번 칸 좌석
          </div>
          <div className="scroll pad">
            <div className="banner">
              <span className="bnum">3</span>
              <span className="btxt">
                타고 계신 <b>3번 칸</b>에<br />
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
  from,
  to,
  onBoard,
}: {
  route: RouteData | null;
  from: string | null;
  to: string | null;
  onBoard: () => void;
}) {
  if (!route || route.error || !route.legs.some((l) => l.type === "subway")) {
    return (
      <div className="scroll pad" style={{ background: "var(--surface)", color: "var(--muted)", fontSize: 13 }}>
        경로를 불러오지 못했어요{route?.error ? ` (${route.error})` : ""}.
      </div>
    );
  }
  const subway = route.legs.filter((l) => l.type === "subway");
  const doorText = (d?: string) => {
    if (!d || d === "null" || d === "undefined") return "";
    return d === "L" ? "왼쪽" : d === "R" ? "오른쪽" : d;
  };
  return (
    <div className="scroll" style={{ background: "var(--surface)" }}>
      <div className="pad">
        <div className="dj-head">
          <div className="dur">{route.totalTime}분</div>
          <div className="sub">
            {from ? withYeok(from) : ""} → {to ? withYeok(to) : ""} · 환승 {route.transferCount}회 · {route.payment?.toLocaleString()}원
          </div>
          <div className="dj-note">ODsay 경로 기준 · 현재 소요시간</div>
        </div>
        <div className="journey">
          {subway.map((l, i) => (
            <div className="jrow" key={i}>
              <div className="jrail">
                <span
                  className="jbadge"
                  style={{ background: l.color, width: "auto", minWidth: 22, padding: "0 4px", borderRadius: 7, fontSize: 8.5 }}
                >
                  {l.line}
                </span>
                {i < subway.length - 1 && <span className="jline" style={{ background: l.color }} />}
              </div>
              <div className="jbody">
                <div className="jstation">
                  {l.start} <span className="chev">→ {l.end}</span>
                </div>
                <div className="jmeta">
                  {l.way ? (
                    <>
                      <span className="dir">{l.way} 방면</span> ·{" "}
                    </>
                  ) : null}
                  {l.stationCount}개 역 · {l.min}분
                  {doorText(l.door) ? ` · 내리는 문 ${doorText(l.door)}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="sticky-cta">
        <button className="btn" onClick={onBoard}>
          이 열차 탑승 칸 선택 →
        </button>
      </div>
    </div>
  );
}
