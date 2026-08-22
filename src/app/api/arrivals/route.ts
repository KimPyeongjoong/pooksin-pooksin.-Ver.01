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

// min: 도착까지 남은 분. sec가 0이면 이미 도착/출발 중이라 0으로 둡니다.
type Train = { msg: string; sec: number; min: number; dest: string };
// updn: 이 방면이 상행인지 하행인지 (시간표 화면에서 같은 방향을 열어주려고 씁니다)
type Group = { line: string; dir: string; updn: "up" | "down"; trains: Train[] };

// "성수행 - 강남구청방면" → 행선지 "성수"
function destOf(trainLineNm: string): string {
  const m = String(trainLineNm || "").match(/^([^행]+)행/);
  return m ? m[1].trim() : "";
}

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
    // 사용자마다 따로 부르지 않도록 서버에 15초 담아둡니다.
    // (도착정보 시트를 여러 명이 동시에 봐도 서울시 API 호출량은 그대로입니다)
    const res = await fetch(url, { next: { revalidate: 15 } });
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
          // 서울 API의 updnLine은 "상행"/"하행" 또는 "내선"/"외선"(2호선 순환)으로 옵니다.
          // 시간표(ODsay) 기준으로 상행=외선, 하행=내선이라 이렇게 맞춥니다.
          updn: /하행|내선/.test(String(item.updnLine)) ? "down" : "up",
          trains: [],
        });
      }
      const g = map.get(gkey)!;
      if (g.trains.length < 2) {
        const sec = Number(item.barvlDt) || 0;
        g.trains.push({
          msg: item.arvlMsg2 ?? "정보 없음",
          sec,
          min: sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0,
          dest: destOf(item.trainLineNm),
        });
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
