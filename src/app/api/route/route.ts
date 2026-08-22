// 지하철 경로검색 서버 경로 (ODsay)
// 호출 예: /api/route?from=강남&to=사당
//
// ODsay 호출을 아끼기 위해, 역 좌표는 앱에 내장된 station-coords.json에서 먼저 찾습니다.
// (예전에는 검색 1번마다 ODsay를 3번 불렀습니다: 출발역 좌표 + 도착역 좌표 + 경로)

import coordsJson from "@/lib/station-coords.json";
import { lineColor, shortLine } from "@/lib/line-colors";
import { buildShortRoute } from "@/lib/short-route";
import { findRoutes, knownStation, transferCases } from "@/lib/route-engine";
import { directionFor } from "@/lib/timetable";
import { lineStations } from "@/lib/lines";

const ODSAY = "https://api.odsay.com/v1/api";
const COORDS = coordsJson as Record<string, { x: number; y: number }>;

type Pt = { x: number; y: number };

// ODsay는 요청이 몰리면 깔끔한 오류 대신 연결을 끊어버립니다.
// 대부분 잠깐이면 풀리므로 한 번은 조용히 다시 시도합니다.
async function fetchOnce(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  return res.json();
}
// ODsay 오류는 두 가지 모양으로 옵니다.
//   { error: { code, message } }        ← 보통
//   { error: [ { code, message } ] }    ← 하루 한도 초과 등 일부 응답
// 배열인 줄 모르고 객체로만 읽으면 code·message가 undefined가 되어,
// "하루 한도 초과"가 "일시적 연결 불안정"으로 잘못 안내됩니다.
type OdsayResp = { error?: unknown } | null | undefined;
function errOf(data: OdsayResp) {
  const raw = Array.isArray(data?.error) ? data?.error[0] : data?.error;
  const e = raw as { code?: unknown; message?: unknown } | null | undefined;
  if (!e) return null;
  return { code: String(e.code ?? ""), message: String(e.message ?? "") };
}

// 오늘 쓸 수 있는 호출 횟수를 다 쓴 경우 (다시 시도해도 소용없음)
function isQuota(data: OdsayResp) {
  const e = errOf(data);
  if (!e) return false;
  return e.code === "429" || /daily quota|quota exceeded|일일|하루/i.test(e.message);
}

// 호출이 몰렸을 때 ODsay가 주는 반응 (연결 끊김 또는 "Too Many Requests")
function isBusy(data: OdsayResp) {
  const e = errOf(data);
  if (!e) return false;
  if (isQuota(data)) return false; // 한도 초과는 "몰림"이 아니라 별도 안내
  return /too many|limit|초과/i.test(e.message) || e.code === "500";
}
async function odsay(url: string) {
  try {
    const data = await fetchOnce(url);
    if (!isBusy(data)) return data;
  } catch {
    // 연결이 끊긴 경우도 아래에서 한 번 더 시도합니다
  }
  await new Promise((r) => setTimeout(r, 900));
  return fetchOnce(url); // 두 번째도 실패하면 호출한 쪽에서 처리
}

// 역 좌표: 내장 파일 우선, 없으면 ODsay에 물어봅니다(현재 655개 중 2개만 해당)
async function findStation(key: string, name: string): Promise<Pt | null> {
  const hit = COORDS[name];
  if (hit) return hit;
  const url = `${ODSAY}/searchStation?apiKey=${encodeURIComponent(key)}&stationName=${encodeURIComponent(name)}&stationClass=2`;
  const data = await odsay(url);
  const list: { stationName: string; x: number; y: number }[] = data?.result?.station ?? [];
  const exact = list.find((s) => s.stationName === name) ?? list[0];
  return exact ? { x: Number(exact.x), y: Number(exact.y) } : null;
}

// 같은 두 역을 여러 사람이(또는 한 사람이 여러 번) 검색하는 일이 잦습니다.
// ODsay가 주는 소요시간은 평균값이라 시각과 무관하므로, 성공한 결과만 담아둡니다.
//
// ⚠️ fetch 단계 캐시(next.revalidate)를 쓰지 않는 이유: ODsay는 한도 초과도
// HTTP 200에 오류 본문으로 주기 때문에, 그 오류까지 캐시되어 한도가 풀린 뒤에도
// 몇 시간 동안 계속 실패하게 됩니다. 그래서 여기서 성공만 골라 담습니다.
const routeCache = new Map<string, { at: number; body: unknown }>();
const ROUTE_CACHE_MS = 6 * 60 * 60 * 1000; // 6시간

type Fail = { error: string; kind: "same" | "tooClose" | "retry" | "notFound" | "quota"; options: [] };
const fail = (kind: Fail["kind"], error: string, status = 200) =>
  Response.json({ error, kind, options: [] }, { status });

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!from || !to) return fail("notFound", "출발역과 도착역이 필요해요", 400);
  if (from === to) return fail("same", "출발역과 도착역이 같습니다");

  // ── 우리가 직접 계산합니다 (외부 호출 0건) ────────────────
  //
  // 예전에는 이 화면이 ODsay에만 기대고 있었는데, 무료 한도가 하루 1,000건이라
  // 조금만 써도 경로검색이 통째로 멈췄습니다. 이제 앱에 내장된 노선도 + 구간
  // 소요시간으로 직접 계산합니다. 한도도 비용도 없습니다.
  //
  // 정확도 확인: 2호선 홍대입구→강남을 39분으로 계산 = 실제 열차 39.0분.
  //
  // ODsay만 주던 정보(빠른 환승 칸·내리는 문 방향)는 이제 없습니다.
  // 그건 원래 이 앱이 사용자에게서 모으려던 종류의 정보입니다.
  if (knownStation(from) && knownStation(to)) {
    const options = findRoutes(from, to);
    if (options.length) {
      for (const o of options) {
        for (const leg of o.legs) {
          // 상행/하행. 이게 없으면 "곧 오는 열차"에 반대 방향 열차가 뜹니다.
          // (5호선 종로3가에서 동대문역사문화공원으로 가는데 "방화행"이 뜨던 문제)
          (leg as { wayCode: number | null }).wayCode = await directionFor(leg.line, leg.start, leg.end);
        }
        // 빠른 환승 칸 — "이 칸에 타고 있으면 다음 환승이 빠릅니다".
        // 환승역에서 내리는 위치(호차-문)를 그 앞 구간에 붙여줍니다.
        for (let i = 0; i + 1 < o.legs.length; i++) {
          const here = o.legs[i];
          const next = o.legs[i + 1];
          const cases = transferCases(here.end, here.line, next.line);
          if (!cases.length) continue;
          // 같은 역이라도 어느 방향에서 왔느냐에 따라 내리는 칸이 다릅니다.
          // 이 구간이 진행하던 방향의 다음 역 이름으로 골라냅니다.
          const order = lineStations(here.line);
          const iEnd = order.indexOf(here.end);
          const iPrev = order.indexOf(here.stations[here.stations.length - 2] ?? here.start);
          const ahead = iEnd >= 0 && iPrev >= 0 ? order[iEnd + Math.sign(iEnd - iPrev)] : undefined;
          const hit =
            (ahead ? cases.find((c) => c.fromWay === ahead.replace(/\s/g, "")) : undefined) ?? cases[0];
          (here as { door: string }).door = hit.off;
        }
      }
      return Response.json({ from, to, options, engine: "local" });
    }
  }

  // ── 여기부터는 엔진이 경로를 못 찾았을 때만 (노선도에 없는 역 등) ──
  const key = process.env.ODSAY_API_KEY || "";
  if (!key) return fail("notFound", "경로 서비스 설정이 필요해요");

  const cacheKey = `${from}→${to}`;
  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ROUTE_CACHE_MS) {
    return Response.json(cached.body);
  }

  try {
    const [s, e] = await Promise.all([findStation(key, from), findStation(key, to)]);
    if (!s || !e) return fail("notFound", "역 위치를 찾지 못했어요");

    const url =
      `${ODSAY}/searchPubTransPathT?apiKey=${encodeURIComponent(key)}` +
      `&SX=${s.x}&SY=${s.y}&EX=${e.x}&EY=${e.y}&SearchPathType=1`;
    const data = await odsay(url);

    // -98 = 출발지와 도착지가 너무 가까움(약 700m 미만). ODsay가 경로를 주지 않으므로
    // 노선도와 실제 시간표로 우리가 직접 구간을 만들어 보여줍니다.
    if (String(data?.error?.code) === "-98") {
      const built = await buildShortRoute(from, to);
      if (built) {
        const body = { from, to, options: [built], builtLocally: true };
        routeCache.set(cacheKey, { at: Date.now(), body });
        return Response.json(body);
      }
      return fail("tooClose", "두 역이 매우 가까워 경로를 만들지 못했어요");
    }

    // 호출 초과·서버 오류를 "경로 없음"으로 보여주면 안 됩니다(경로는 있는데 못 물어본 것)
    if (isQuota(data)) return fail("quota", "오늘 경로검색 사용량을 다 썼어요");
    if (isBusy(data)) return fail("retry", "잠시 후 다시 시도해 주세요");
    if (data?.error) return fail("retry", "잠시 후 다시 시도해 주세요");
    if (!data?.result?.path?.length) return fail("notFound", "경로를 찾지 못했어요");

    // 여러 후보 경로를 정규화해서 반환 (필터 탭이 이 중에서 골라 씀)
    const paths = (data.result.path as Record<string, any>[]).slice(0, 8);
    const options = paths.map((path) => {
      const info = path.info;
      const legs = (path.subPath || []).map((p: Record<string, any>) => {
        if (p.trafficType === 1) {
          const laneName = p.lane?.[0]?.name || "지하철";
          return {
            type: "subway",
            line: shortLine(laneName),
            color: lineColor(laneName),
            start: p.startName,
            end: p.endName,
            stationCount: p.stationCount,
            min: p.sectionTime,
            way: p.way || "",
            door: p.door || "",
            // 실제 시간표 조회용: 승차역 ODsay ID + 상행(1)/하행(2)
            stationID: p.startID ?? null,
            wayCode: p.wayCode ?? null,
            stations: (p.passStopList?.stations || []).map((x: { stationName: string }) => x.stationName),
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

    const body = { from, to, options };
    routeCache.set(cacheKey, { at: Date.now(), body });
    return Response.json(body);
  } catch (err) {
    // 연결이 끊긴 경우(호출 몰림 등) — 사용자에겐 다시 시도를 안내합니다
    console.error("[/api/route]", err);
    return fail("retry", "잠시 후 다시 시도해 주세요");
  }
}
