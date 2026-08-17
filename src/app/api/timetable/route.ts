// 지하철역 "실제 시간표" 서버 경로 (ODsay subwayTimeTable)
//
// 호출 예: /api/timetable?stationID=222&wayCode=2
//   stationID = ODsay 역 ID (경로검색 응답의 startID를 그대로 넘기면 됩니다)
//   wayCode   = 1(상행/외선) | 2(하행/내선)
//
// 왜 필요한가:
//   이전에는 발차 시각을 "지금 시각"으로 잡고 ±3분씩 움직였습니다(가짜 근사).
//   이 경로는 그 역에서 실제로 열차가 몇 시 몇 분에 떠나는지를 그대로 돌려줍니다.
//
// 참고: 서울열린데이터광장의 시간표 서비스(SearchSTNTimeTableByIDService)는
//       현재 어떤 역코드/요일/상하행 조합으로 불러도 빈 응답이라 사용할 수 없습니다.

const ODSAY = "https://api.odsay.com/v1/api";

export type Departure = {
  min: number; // 자정 기준 분 (24시 이후 심야편은 1440 이상)
  dest: string; // 행선지 (예: "성수")
};

type DayType = "weekday" | "sat" | "sun";

// 시간표는 하루 동안 바뀌지 않으므로 서버 메모리에 잠깐 저장해 API 호출을 아낍니다.
const cache = new Map<string, { at: number; body: unknown }>();
const CACHE_MS = 6 * 60 * 60 * 1000; // 6시간

// 한국 시간(KST) 기준 오늘 요일 (0=일 … 6=토)
function kstDay(): number {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.getUTCDay();
}

function dayTypeOf(day: number): DayType {
  if (day === 0) return "sun";
  if (day === 6) return "sat";
  return "weekday";
}

// ODsay 시간표 한 칸("44(성수) 57(성수)")을 분 단위 목록으로 풉니다.
function parseHour(hour: number, list: string): Departure[] {
  const out: Departure[] = [];
  for (const token of String(list || "").trim().split(/\s+/)) {
    if (!token) continue;
    const m = token.match(/^(\d{1,2})(?:\(([^)]*)\))?/);
    if (!m) continue;
    const mm = Number(m[1]);
    if (!Number.isFinite(mm)) continue;
    out.push({ min: hour * 60 + mm, dest: m[2] || "" });
  }
  return out;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const stationID = searchParams.get("stationID");
  const wayCode = searchParams.get("wayCode") === "2" ? "down" : "up";

  if (!stationID) {
    return Response.json({ error: "stationID 필요", departures: [] }, { status: 400 });
  }

  const key = process.env.ODSAY_API_KEY || "";
  if (!key) return Response.json({ error: "ODSAY_API_KEY 없음", departures: [] });

  const day = kstDay();
  const dayType = dayTypeOf(day);
  const cacheKey = `${stationID}|${wayCode}|${dayType}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return Response.json(hit.body);
  }

  try {
    const url = `${ODSAY}/subwayTimeTable?apiKey=${encodeURIComponent(key)}&stationID=${encodeURIComponent(stationID)}`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    const r = data?.result;
    if (data?.error || !r) {
      return Response.json({ error: data?.error?.message || "시간표를 받지 못했어요", departures: [] });
    }

    // 평일 / 토요일 / 일요일·공휴일
    const listKey = dayType === "sun" ? "SunList" : dayType === "sat" ? "SatList" : "OrdList";
    // 해당 요일 시간표가 비어 있으면 평일 시간표로 대체
    const table = r[listKey]?.[wayCode]?.time?.length ? r[listKey] : r.OrdList;
    const rows: { Idx: number; list: string }[] = table?.[wayCode]?.time ?? [];

    const departures = rows
      .flatMap((row) => parseHour(Number(row.Idx), row.list))
      .sort((a, b) => a.min - b.min);

    const body = {
      stationID: Number(stationID),
      stationName: r.stationName ?? "",
      line: String(r.laneName || "").replace(/^수도권\s*/, ""),
      way: wayCode, // "up" | "down"
      wayLabel: (wayCode === "up" ? r.upWay : r.downWay) ?? "",
      dayType, // weekday | sat | sun  (공휴일은 구분하지 못합니다)
      departures,
    };

    cache.set(cacheKey, { at: Date.now(), body });
    return Response.json(body);
  } catch (err) {
    return Response.json({ error: String(err), departures: [] });
  }
}
