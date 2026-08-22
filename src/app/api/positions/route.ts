// 실시간 열차 위치 서버 경로 (서울열린데이터광장 realtimePosition)
//
// 호출 예: /api/positions?line=2호선
//
// 지금 그 노선 위를 달리는 열차가 "어느 역에" 있는지 알려줍니다.
// 서울교통공사가 운영하는 노선만 제공됩니다(인천1호선 등은 데이터 없음).

const LINE_ALIASES: Record<string, string> = {
  "경의중앙선": "경의중앙선",
  "경의·중앙선": "경의중앙선",
  "우이신설경전철": "우이신설선",
  "서해": "서해선",
  "신림": "신림선",
  "분당선": "수인분당선",
};

// 열차 상태 코드 → 사람이 읽는 말
const STATUS: Record<string, string> = {
  "0": "진입",
  "1": "도착",
  "2": "출발",
  "3": "전역출발",
};

export type TrainPos = {
  trainNo: string;
  station: string; // 지금 있는 역
  dest: string; // 종착역
  updn: "up" | "down"; // 0=상행/내선, 1=하행/외선
  status: string; // 진입/도착/출발/전역출발
  express: boolean;
  last: boolean; // 막차 여부
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("line") ?? "";
  const line = LINE_ALIASES[raw] ?? raw;
  if (!line) return Response.json({ error: "line 필요", trains: [] }, { status: 400 });

  const key = process.env.SEOUL_OPEN_API_KEY || "sample";

  try {
    const url =
      `http://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimePosition/0/200/` +
      encodeURIComponent(line);
    // ⚠️ 사용자마다 따로 부르면 안 됩니다.
    //
    // 이 화면들은 20초마다 자동 갱신됩니다. 브라우저가 부를 때마다 서울시 API를
    // 그대로 부르면, 100명이 보고 있을 때 시간당 수만 건이 나가 하루 한도를
    // 순식간에 씁니다. 서버 캐시에 15초만 담아두면 몇 명이 보든 호출량은 같습니다.
    const res = await fetch(url, { next: { revalidate: 15 } });
    const data = await res.json();
    const list: Record<string, string>[] = data?.realtimePositionList ?? [];

    if (!list.length) {
      // 서울교통공사 운영 노선이 아니면 여기로 옵니다.
      return Response.json({
        line,
        supported: false,
        reason: "이 노선의 실시간 열차 위치는 공공데이터로 제공되지 않아요",
        trains: [],
      });
    }

    // 서울 API의 updnLine은 0=상행(순환선은 내선), 1=하행(순환선은 외선)입니다.
    // 앱은 시간표(ODsay)에 맞춰 상행=외선=up, 하행=내선=down으로 통일하므로
    // 순환선인 2호선만 반대로 뒤집습니다.
    const circular = /2호선/.test(line);
    const trains: TrainPos[] = list.map((t) => ({
      trainNo: t.trainNo ?? "",
      station: (t.statnNm ?? "").trim(),
      dest: (t.statnTnm ?? "").replace(/종착$/, "").trim(),
      updn: circular
        ? t.updnLine === "1"
          ? "up"
          : "down"
        : t.updnLine === "1"
          ? "down"
          : "up",
      status: STATUS[t.trainSttus] ?? "",
      express: t.directAt === "1" || t.directAt === "7",
      last: t.lstcarAt === "1",
    }));

    // 데이터 생성 시각(HH:MM)
    const recptn = String(list[0]?.recptnDt ?? "");
    const updatedAt = recptn.includes(" ") ? recptn.split(" ")[1].slice(0, 5) : "";

    return Response.json({ line, supported: true, updatedAt, count: trains.length, trains });
  } catch (err) {
    return Response.json({ line, supported: false, reason: String(err), trains: [] });
  }
}
