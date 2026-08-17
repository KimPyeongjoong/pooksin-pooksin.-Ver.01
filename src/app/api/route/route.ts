// 지하철 경로검색 서버 경로 (ODsay)
// 호출 예: /api/route?from=강남&to=사당
// 출발·도착 역명 → ODsay로 좌표를 찾고 → 대중교통(지하철) 경로를 계산합니다.

const ODSAY = "https://api.odsay.com/v1/api";

const LINE_COLORS: Record<string, string> = {
  "1호선": "#0052A4", "2호선": "#00A84D", "3호선": "#EF7C1C", "4호선": "#00A5DE",
  "5호선": "#996CAC", "6호선": "#CD7C2F", "7호선": "#747F00", "8호선": "#E6186C",
  "9호선": "#BDB092", "신분당선": "#D31145", "수인분당선": "#FABE00", "분당선": "#FABE00",
  "경의중앙선": "#77C4A3", "공항철도": "#0090D2", "경춘선": "#0C8E72", "경강선": "#003DA5",
  "서해선": "#8FC31F", "우이신설선": "#B7C452", "김포골드라인": "#AD8605", "신림선": "#6789CA",
  "인천1호선": "#7CA8D5", "인천2호선": "#ED8B00", "의정부경전철": "#FDA600", "용인경전철": "#509F22",
};
function shortLine(name: string): string {
  return (name || "").replace(/^수도권\s*/, "").replace(/^인천\s*/, "인천").trim();
}
function colorFor(name: string): string {
  return LINE_COLORS[shortLine(name)] ?? "#888888";
}

async function findStation(key: string, name: string) {
  const url = `${ODSAY}/searchStation?apiKey=${encodeURIComponent(key)}&stationName=${encodeURIComponent(name)}&stationClass=2`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  const list: any[] = data?.result?.station ?? [];
  const exact = list.find((s) => s.stationName === name) ?? list[0];
  return exact ? { x: exact.x, y: exact.y } : null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!from || !to) return Response.json({ error: "from/to 필요", options: [] }, { status: 400 });

  const key = process.env.ODSAY_API_KEY || "";
  if (!key) return Response.json({ error: "ODSAY_API_KEY 없음", options: [] });

  try {
    const [s, e] = await Promise.all([findStation(key, from), findStation(key, to)]);
    if (!s || !e) return Response.json({ error: "역 좌표를 찾지 못했어요", options: [] });

    const url =
      `${ODSAY}/searchPubTransPathT?apiKey=${encodeURIComponent(key)}` +
      `&SX=${s.x}&SY=${s.y}&EX=${e.x}&EY=${e.y}&SearchPathType=1`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (data.error || !data?.result?.path?.length) {
      return Response.json({ error: data?.error?.message || "경로를 찾지 못했어요", options: [] });
    }

    // 여러 후보 경로를 정규화해서 반환 (필터 탭이 이 중에서 골라 씀)
    const paths = (data.result.path as any[]).slice(0, 8);
    const options = paths.map((path) => {
      const info = path.info;
      const legs = (path.subPath || []).map((p: any) => {
        if (p.trafficType === 1) {
          const laneName = p.lane?.[0]?.name || "지하철";
          return {
            type: "subway",
            line: shortLine(laneName),
            color: colorFor(laneName),
            start: p.startName,
            end: p.endName,
            stationCount: p.stationCount,
            min: p.sectionTime,
            way: p.way || "",
            door: p.door || "",
            stations: (p.passStopList?.stations || []).map((s: any) => s.stationName),
          };
        }
        if (p.trafficType === 3) {
          return { type: "walk", min: p.sectionTime || 0, distance: p.distance || 0 };
        }
        return { type: "etc", min: p.sectionTime || 0 };
      });
      return {
        totalTime: info.totalTime,
        payment: info.payment,
        transferCount: Math.max(0, (info.subwayTransitCount || 1) - 1),
        stationCount: info.totalStationCount,
        legs,
      };
    });

    return Response.json({ from, to, options });
  } catch (err) {
    return Response.json({ error: String(err), options: [] });
  }
}
