// 실시간 지하철 자료 (서울열린데이터광장) — 서버에서만 씁니다
//
// 두 가지를 가져옵니다.
//   ① 열차 위치 realtimePosition  — 그 **노선 전체**의 열차가 지금 어느 역에 있는지
//   ② 도착 정보 realtimeStationArrival — 그 **역**에 곧 도착할 열차의 남은 시간(초)
//
// ⚠️ 사용자마다 따로 부르면 안 됩니다.
//    화면이 20초마다 갱신되므로, 브라우저가 부를 때마다 서울시 API를 그대로 부르면
//    100명이 보고 있을 때 시간당 수만 건이 나갑니다.
//    `next: { revalidate: 15 }` 로 서버에 15초 담아두면 몇 명이 보든 호출량은 같습니다.
//
// 서울교통공사가 운영하지 않는 노선(인천1·2호선, 김포골드라인, 의정부·용인경전철, GTX)은
// 아예 제공되지 않습니다 — 그럴 땐 supported:false 로 알려주고 시간표로 대체합니다.

const SEOUL = "http://swopenapi.seoul.go.kr/api/subway";

// 노선 이름 표기 차이 흡수 (서울시 API가 쓰는 이름으로 맞춥니다)
const LINE_ALIASES: Record<string, string> = {
  경의중앙선: "경의중앙선",
  "경의·중앙선": "경의중앙선",
  우이신설경전철: "우이신설선",
  서해: "서해선",
  신림: "신림선",
  분당선: "수인분당선",
};

// 열차 상태 코드 → 사람이 읽는 말
const STATUS: Record<string, string> = { "0": "진입", "1": "도착", "2": "출발", "3": "전역출발" };

export type TrainPos = {
  trainNo: string;
  station: string; // 지금 있는 역 (status 와 함께 봐야 합니다)
  dest: string; // 종착역
  updn: "up" | "down";
  status: string; // 진입 / 도착 / 출발 / 전역출발
  express: boolean;
  last: boolean; // 막차 여부
};

export type Positions = {
  line: string;
  supported: boolean;
  updatedAt: string;
  trains: TrainPos[];
  reason?: string;
};

// 경로 결과의 급행 구간은 "1호선(급행)"으로 옵니다 — 실시간은 노선 단위라 괄호를 뗍니다.
export const liveLineName = (raw: string) => {
  const s = (raw ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  return LINE_ALIASES[s] ?? s;
};

export async function fetchPositions(rawLine: string): Promise<Positions> {
  const line = liveLineName(rawLine);
  if (!line) return { line: "", supported: false, updatedAt: "", trains: [], reason: "노선 이름이 없어요" };
  const key = process.env.SEOUL_OPEN_API_KEY || "sample";
  try {
    const url = `${SEOUL}/${key}/json/realtimePosition/0/200/${encodeURIComponent(line)}`;
    const res = await fetch(url, { next: { revalidate: 15 } });
    const data = await res.json();
    const list: Record<string, string>[] = data?.realtimePositionList ?? [];
    if (!list.length)
      return {
        line,
        supported: false,
        updatedAt: "",
        trains: [],
        reason: "이 노선의 실시간 열차 위치는 공공데이터로 제공되지 않아요",
      };

    // ⚠️ 서울 API의 updnLine 은 0=상행(순환선은 내선), 1=하행(순환선은 외선)입니다.
    //    앱은 시간표(서울교통공사)에 맞춰 상행=외선=up, 하행=내선=down 으로 통일합니다.
    //
    //    **두 자료의 상/하행이 반대인 노선이 있습니다.**
    //    16개 노선을 실측해 대조했습니다(2026-08-23). 각 노선의 실시간 열차 행선지가
    //    노선 순서상 앞으로 가는지 뒤로 가는지 세어, 같은 역 시간표의 상행 행선지와 비교했습니다.
    //      · 2호선 — 순환선이라 반대 (34대 두 번 표본으로 확인)
    //      · 9호선 — **반대**. 실시간 up 13대가 전부 개화 방향인데 시간표 상행은 중앙보훈병원 방향입니다.
    //      · 나머지 14개 노선 — 같음
    //    안 뒤집으면 "곧 오는 열차"에 반대 방향 열차가 뜹니다.
    const FLIPPED = new Set(["2호선", "9호선"]);
    const circular = FLIPPED.has(line);
    const trains: TrainPos[] = list.map((t) => ({
      trainNo: t.trainNo ?? "",
      station: (t.statnNm ?? "").trim(),
      // 6호선은 행선지를 "응암순환(상선)"처럼 줍니다 — 괄호와 "종착"을 떼어냅니다
      dest: (t.statnTnm ?? "").replace(/\s*\([^)]*\)\s*$/, "").replace(/종착$/, "").trim(),
      updn: circular ? (t.updnLine === "1" ? "up" : "down") : t.updnLine === "1" ? "down" : "up",
      status: STATUS[t.trainSttus] ?? "",
      express: t.directAt === "1" || t.directAt === "7",
      last: t.lstcarAt === "1",
    }));
    const recptn = String(list[0]?.recptnDt ?? "");
    const updatedAt = recptn.includes(" ") ? recptn.split(" ")[1].slice(0, 5) : "";
    return { line, supported: true, updatedAt, trains };
  } catch (err) {
    return { line, supported: false, updatedAt: "", trains: [], reason: String(err) };
  }
}

// 그 역에 곧 도착할 열차의 남은 시간(초).
//
// ⚠️ **남은 시간을 안 주는 노선이 있습니다.** `barvlDt` 가 0으로만 오는 노선:
//    경의중앙 · 공항철도 · 수인분당 · 신분당 · 서해 · 우이신설, 그리고 1·4호선 코레일 구간.
//    그럴 땐 이 값을 버리고 열차 위치로 계산한 값을 씁니다(추정치를 진짜인 척 하지 않습니다).
export type ArrivalHint = { trainNo: string; sec: number; updn: "up" | "down"; msg: string };

export async function fetchArrivalHints(station: string): Promise<ArrivalHint[]> {
  const key = process.env.SEOUL_OPEN_API_KEY || "sample";
  try {
    const url = `${SEOUL}/${key}/json/realtimeStationArrival/0/20/${encodeURIComponent(station)}`;
    const res = await fetch(url, { next: { revalidate: 15 } });
    const data = await res.json();
    const list: Record<string, string>[] = data?.realtimeArrivalList ?? [];
    return list
      .map((t) => ({
        trainNo: String(t.btrainNo ?? "").trim(),
        sec: Number(t.barvlDt) || 0,
        updn: /하행|내선/.test(String(t.updnLine)) ? ("down" as const) : ("up" as const),
        msg: String(t.arvlMsg2 ?? ""),
      }))
      .filter((t) => t.trainNo);
  } catch {
    return [];
  }
}
