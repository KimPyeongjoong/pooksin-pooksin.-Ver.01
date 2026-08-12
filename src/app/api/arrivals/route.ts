// 실시간 지하철 도착정보 서버 경로
// 브라우저가 직접 서울 API를 부르면 (1) CORS 오류 (2) 키 노출 문제가 생깁니다.
// 그래서 우리 서버가 대신 호출해서 깔끔하게 정리한 뒤 브라우저에 넘깁니다.
//
// 호출 예: /api/arrivals?station=강남
// 실제 데이터 출처: 서울열린데이터광장 (서울 지역만 제공)

// 지하철 노선 ID → 사람이 읽는 이름
const LINE_NAMES: Record<string, string> = {
  "1001": "1호선", "1002": "2호선", "1003": "3호선", "1004": "4호선",
  "1005": "5호선", "1006": "6호선", "1007": "7호선", "1008": "8호선",
  "1009": "9호선", "1063": "경의중앙", "1065": "공항철도", "1067": "경춘",
  "1075": "수인분당", "1077": "신분당", "1092": "우이신설", "1093": "서해",
  "1081": "경강",
};

type Train = { msg: string; sec: number };
type Group = { line: string; dir: string; trains: Train[] };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const station = searchParams.get("station") ?? "강남";

  // 환경변수에 키가 없으면 무료 샘플 키로 동작 (가입 전에도 테스트 가능)
  const key = process.env.SEOUL_OPEN_API_KEY || "sample";
  const usingSample = !process.env.SEOUL_OPEN_API_KEY;

  const url =
    `http://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimeStationArrival/0/15/` +
    encodeURIComponent(station);

  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    const list: any[] = data?.realtimeArrivalList ?? [];

    // 노선 + 방향(상/하행)으로 묶고, 각 그룹당 가까운 열차 2대까지
    const map = new Map<string, Group>();
    for (const item of list) {
      const gkey = `${item.subwayId}|${item.updnLine}`;
      if (!map.has(gkey)) {
        map.set(gkey, {
          line: LINE_NAMES[item.subwayId] ?? "지하철",
          dir: item.trainLineNm ?? "",
          trains: [],
        });
      }
      const g = map.get(gkey)!;
      if (g.trains.length < 2) {
        g.trains.push({ msg: item.arvlMsg2 ?? "정보 없음", sec: Number(item.barvlDt) || 0 });
      }
    }

    const groups = [...map.values()];
    // 데이터 생성 시각(HH:MM)
    const recptn: string = list[0]?.recptnDt ?? "";
    const updatedAt = recptn.includes(" ") ? recptn.split(" ")[1].slice(0, 5) : "";

    return Response.json({
      station,
      source: usingSample ? "sample" : "live",
      updatedAt,
      count: list.length,
      groups,
    });
  } catch {
    // 네트워크 실패 등 → 빈 결과 (앱은 목업으로 대체)
    return Response.json({ station, source: "error", updatedAt: "", count: 0, groups: [] });
  }
}
