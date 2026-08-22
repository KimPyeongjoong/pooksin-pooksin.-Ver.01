// 지하철역 "실제 시간표" 서버 경로
//
// 호출 방법:
//   /api/timetable?station=종로3가&line=5호선   ← 이렇게 부르는 것을 권장합니다
//   /api/timetable?stationID=222              ← 예전 방식(ODsay 역 ID)
//
// 어디서 오는가 — 두 갈래입니다.
//   ① 앱에 내장된 시간표 (대부분)  … 외부 호출 0건
//      공공데이터포털 "서울교통공사_열차시간표"를 scripts/build-timetable.mjs 로 미리 받아둔 것.
//      1~9호선 · 수인분당 · 신분당 · 공항철도 · 신림선.
//   ② ODsay (나머지)             … 경의중앙 · 인천1 · 우이신설. 이 노선만 남았습니다.
//
// 왜 이렇게 바꿨나: 시간표는 1년에 두어 번 바뀌는 고정 데이터인데 화면을 열 때마다
// ODsay에 물어보고 있었습니다. ODsay는 하루 호출 한도(무료 1,000건)가 있어 금방 바닥납니다.
//
// 돌려주는 것:
//   평일 / 토요일 / 휴일 × 상행·하행 시간표 전부 + 오늘이 어느 쪽인지.
//   (화면에서 탭을 눌러 바꿀 때 다시 부르지 않아도 되도록 한 번에 다 보냅니다.)
//
// 참고: 서울열린데이터광장의 시간표 서비스(SearchSTNTimeTableByIDService)는
//       어떤 역코드/요일/상하행 조합으로 불러도 빈 응답이라 사용할 수 없습니다.

import { dayTypeOf, holidayDataCovers, isHoliday, kstDateKey, type DayType } from "@/lib/holidays";
import { lineColor, shortLine } from "@/lib/line-colors";
import { linesAtStation } from "@/lib/lines";
import { isCovered, stationTimetable } from "@/lib/timetable";

const ODSAY = "https://api.odsay.com/v1/api";

export type Departure = {
  min: number; // 자정 기준 분 (24시 이후 심야편은 1440 이상)
  dest: string; // 행선지 (예: "성수")
};

type Dirs = { up: Departure[]; down: Departure[] };

// 시간표는 하루 동안 바뀌지 않으므로 서버 메모리에 잠깐 저장해 API 호출을 아낍니다.
const cache = new Map<string, { at: number; body: unknown }>();
const CACHE_MS = 6 * 60 * 60 * 1000; // 6시간

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

type OdsayDirection = { time?: { Idx: number | string; list: string }[] };
function toDirs(list: { up?: OdsayDirection; down?: OdsayDirection } | undefined): Dirs {
  const pick = (d: OdsayDirection | undefined): Departure[] =>
    (d?.time ?? [])
      .flatMap((row) => parseHour(Number(row.Idx), row.list))
      .sort((a, b) => a.min - b.min);
  return { up: pick(list?.up), down: pick(list?.down) };
}

type StationHit = { stationID: number; stationName: string; laneName: string };

// ODsay 오류는 객체일 때도, 배열일 때도(하루 한도 초과 등) 있습니다.
// 배열인 줄 모르고 객체로만 읽으면 "한도 초과"가 "역을 못 찾음"으로 잘못 안내됩니다.
function odsayError(data: { error?: unknown } | null | undefined) {
  const raw = Array.isArray(data?.error) ? data?.error[0] : data?.error;
  const e = raw as { code?: unknown; message?: unknown } | null | undefined;
  if (!e) return null;
  const code = String(e.code ?? "");
  const message = String(e.message ?? "");
  const quota = code === "429" || /daily quota|quota exceeded/i.test(message);
  return { code, message, quota };
}
const QUOTA_MSG = "오늘 시간표 사용량을 다 썼어요 (내일 다시 쓸 수 있습니다)";

// 역 이름으로 ODsay 역 ID 찾기 (같은 이름의 환승역은 노선마다 ID가 다릅니다)
async function findStations(
  key: string,
  name: string
): Promise<{ hits: StationHit[]; quota: boolean }> {
  const url =
    `${ODSAY}/searchStation?apiKey=${encodeURIComponent(key)}` +
    `&stationName=${encodeURIComponent(name)}&stationClass=2`;
  // 역 ID는 거의 바뀌지 않습니다. ODsay 호출을 아끼려고 하루 담아둡니다.
  const res = await fetch(url, { next: { revalidate: 86400 } });
  const data = await res.json();
  const list: { stationID: number; stationName: string; laneName: string }[] =
    data?.result?.station ?? [];
  return {
    hits: list
      .filter((s) => s.stationName === name)
      .map((s) => ({ stationID: s.stationID, stationName: s.stationName, laneName: s.laneName })),
    quota: !!odsayError(data)?.quota,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const stationIDParam = searchParams.get("stationID");
  const stationName = searchParams.get("station");
  const lineParam = searchParams.get("line");

  const today: DayType = dayTypeOf();

  // ── ① 앱에 내장된 시간표 ─────────────────────────────────
  // 역 이름을 알면 외부 호출 없이 바로 답할 수 있습니다.
  if (stationName) {
    // 이 역에 어떤 노선이 지나는지도 내장 노선도로 만듭니다 (예전엔 ODsay에 물어봤습니다).
    const here = linesAtStation(stationName).map((l) => shortLine(l.label));
    const siblings = here.map((line, i) => ({ stationID: i, line }));
    // 요청한 노선이 없으면, 그 역에서 내장 시간표가 있는 첫 노선을 씁니다.
    const want = lineParam ? shortLine(lineParam) : here.find((l) => isCovered(l)) ?? here[0];

    if (want && isCovered(want)) {
      const t = await stationTimetable(stationName, want);
      if (t) {
        return Response.json({
          stationName,
          line: t.line,
          color: lineColor(t.line),
          upWay: t.upWay,
          downWay: t.downWay,
          today,
          isHoliday: isHoliday(),
          dateKey: kstDateKey(),
          holidayDataStale: !holidayDataCovers(),
          source: "builtin", // 내장 데이터로 답했음 (외부 호출 0건)
          built: t.built, // 시간표를 받아둔 날짜
          lists: t.lists,
          siblings,
        });
      }
    }
  }

  // ── ② 내장 시간표가 없는 노선만 ODsay ─────────────────────
  // 경의중앙 · 인천1 · 우이신설 (공공 시간표에 아예 없는 노선)
  const key = process.env.ODSAY_API_KEY || "";
  if (!key) return Response.json({ error: "ODSAY_API_KEY 없음" }, { status: 500 });

  // 이 역에 어떤 노선들이 지나는지 (화면에서 노선을 고를 수 있게)
  let siblings: { stationID: number; line: string }[] = [];
  let stationID = stationIDParam;

  try {
    if (stationName) {
      const { hits, quota } = await findStations(key, stationName);
      siblings = hits.map((h) => ({ stationID: h.stationID, line: shortLine(h.laneName) }));
      if (quota) return Response.json({ error: QUOTA_MSG });
      if (!hits.length) {
        return Response.json({ error: `'${stationName}' 역을 찾지 못했어요` }, { status: 404 });
      }
      const matched = lineParam
        ? hits.find((h) => shortLine(h.laneName) === shortLine(lineParam))
        : null;
      stationID = String((matched ?? hits[0]).stationID);
    }

    if (!stationID) {
      return Response.json({ error: "stationID 또는 station 필요" }, { status: 400 });
    }

    const cacheKey = `${stationID}|${kstDateKey()}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return Response.json({ ...(hit.body as object), siblings });
    }

    const url = `${ODSAY}/subwayTimeTable?apiKey=${encodeURIComponent(key)}&stationID=${encodeURIComponent(stationID)}`;
    // 시간표는 하루 동안 그대로입니다. 위의 메모리 캐시는 서버가 재시작하면 사라지지만
    // (개발 중에는 파일을 저장할 때마다 사라집니다), 이 캐시는 배포 환경에서도 공유됩니다.
    const res = await fetch(url, { next: { revalidate: 21600 } });
    const data = await res.json();
    const r = data?.result;
    if (data?.error || !r) {
      const e = odsayError(data);
      return Response.json({ error: e?.quota ? QUOTA_MSG : e?.message || "시간표를 받지 못했어요" });
    }

    const line = shortLine(String(r.laneName || ""));
    const lists: Record<DayType, Dirs> = {
      weekday: toDirs(r.OrdList),
      sat: toDirs(r.SatList),
      sun: toDirs(r.SunList),
    };
    // 해당 요일 시간표가 비어 있으면 평일 것으로 채워둡니다(일부 노선 데이터 누락 대비).
    for (const k of ["sat", "sun"] as DayType[]) {
      if (!lists[k].up.length && !lists[k].down.length) lists[k] = lists.weekday;
    }

    const body = {
      stationID: Number(stationID),
      stationName: r.stationName ?? stationName ?? "",
      line,
      color: lineColor(line),
      upWay: r.upWay ?? "", // 상행 방면 (예: "성수(외선)")
      downWay: r.downWay ?? "", // 하행 방면
      today, // weekday | sat | sun
      isHoliday: isHoliday(),
      dateKey: kstDateKey(),
      // 공휴일 목록이 올해까지 없으면 판정을 못 믿는다는 표시
      holidayDataStale: !holidayDataCovers(),
      lists,
    };

    cache.set(cacheKey, { at: Date.now(), body });
    return Response.json({ ...body, siblings });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
