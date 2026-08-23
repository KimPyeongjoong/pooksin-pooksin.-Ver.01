// "이 역에서 곧 타는 열차 3대" — 실시간 기준
//
// 호출 예: /api/next-trains?station=부천&to=용산&line=1호선(급행)&way=1
//
// 왜 이렇게 만드나:
//   서울시 **도착정보**는 한 역·한 방향에 보통 2대까지만 줍니다.
//   그런데 **열차위치**는 그 노선 위를 달리는 열차를 **전부** 줍니다.
//   그래서 "우리 역 쪽으로 오고 있는 열차"를 골라 놓고,
//   앱에 내장된 **구간 소요시간**(공공 시간표에서 뽑은 실측값)으로 도착까지 걸릴 시간을 직접 계산합니다.
//   → 3대든 5대든 만들 수 있고, 열차가 지금 어디 있는지로 계산하니 **지연이 그대로 반영**됩니다.
//
//   도착정보에 그 열차가 있으면(열차번호로 맞춰봄) 거기 적힌 남은 시간(초)을 더 믿고 씁니다.
//
// 실시간이 없는 경우(인천1·2호선·김포·의정부·용인·GTX, 또는 막차 이후)는
// **내장 시간표**로 채웁니다. 어느 쪽에서 온 값인지 `source` 로 알려줍니다.

import { fetchArrivalHints, fetchPositions } from "@/lib/live";
import { lineStations } from "@/lib/lines";
import { shortLine } from "@/lib/line-colors";
import { dayTypeOf } from "@/lib/holidays";
import { stationTimetable } from "@/lib/timetable";
import sectionJson from "@/lib/section-times.json";

const SECTIONS = (sectionJson as { lines: Record<string, Record<string, number>> }).lines;

// 역 이름 표기 차이 흡수 (앱의 다른 곳과 같은 규칙)
const NAME_ALIAS: Record<string, string> = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s: string) =>
  (s || "").replace(/\s/g, "").replace(/[·.]/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();
const norm = (s: string) => NAME_ALIAS[bare(s)] ?? bare(s);

// 두 이웃 역 사이 소요시간(초). 자료에 없으면 수도권 평균으로 어림합니다.
const AVG_HOP_SEC = 120;
function hopSec(line: string, a: string, b: string): number {
  const t = SECTIONS[shortLine(line)];
  return t?.[`${a}|${b}`] ?? t?.[`${b}|${a}`] ?? AVG_HOP_SEC;
}

// 열차 상태에 따른 보정(초).
//   진입  = 그 역에 들어오는 중  → 정차하고 떠날 시간을 조금 더합니다
//   도착  = 그 역에 서 있음      → 정차 시간(30초)을 더합니다
//   출발  = 그 역을 막 떠났음    → 아래 합계가 그대로 맞습니다
//   전역출발 = 앞 역을 떠나 이 역으로 오는 중 → 이 역까지 오는 시간이 더 남았습니다
const STATUS_ADJ: Record<string, number> = { 진입: 15, 도착: 30, 출발: 0, 전역출발: 60 };

const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const station = searchParams.get("station") ?? "";
  const to = searchParams.get("to") ?? ""; // 이 구간에서 내릴 역 (진행 방향을 알아내는 데 씁니다)
  const rawLine = searchParams.get("line") ?? "";
  const way = searchParams.get("way") === "2" ? "down" : "up";
  const want = Number(searchParams.get("count") ?? 3);
  if (!station || !rawLine) {
    return Response.json({ error: "station 과 line 이 필요해요", trains: [] }, { status: 400 });
  }

  // "1호선(급행)" 처럼 오면 급행 구간입니다 — 급행 열차만 셉니다.
  const expressKind = /\((급행|특급)\)$/.exec(rawLine)?.[1] ?? "";
  const line = shortLine(rawLine);

  const out: {
    source: "live" | "timetable";
    etaSec: number | null; // 실시간일 때만
    min: number; // 자정 기준 분 (화면에 시각으로 찍는 값)
    dest: string;
    express: boolean;
    from?: string; // 지금 그 열차가 있는 역
    stops?: number; // 몇 정거장 전
    last?: boolean;
  }[] = [];

  const nowMin = nowMinutes();
  const circular = /2호선/.test(line); // 순환선은 앞뒤 판정을 못 합니다
  const pos = await fetchPositions(rawLine);
  const updatedAt = pos.updatedAt;

  // 진행 방향으로 역을 늘어놓습니다 (내릴 역이 뒤에 오도록)
  const all = lineStations(line).map(norm);
  const si = all.indexOf(norm(station));
  const ei = to ? all.indexOf(norm(to)) : -1;
  const ordered = si >= 0 && ei >= 0 && ei < si ? [...all].reverse() : all;
  const boardIdx = ordered.indexOf(norm(station));
  const toIdx = to ? ordered.indexOf(norm(to)) : -1;

  // "이 열차가 내릴 역까지 가는가" — 중간에서 끝나는 열차(1호선 서동탄행, 7호선 온수행 등)를 거릅니다.
  // 행선지가 이 노선 목록에 없으면 판단을 보류합니다(함부로 버리지 않습니다).
  // 순환선(2호선)은 번호로 앞뒤를 못 가려 검사하지 않습니다.
  const reaches = (dest: string) => {
    if (circular || toIdx < 0 || !dest) return true;
    const di = ordered.indexOf(norm(dest));
    return di < 0 ? true : di >= toIdx;
  };

  if (pos.supported) {
    if (boardIdx >= 0) {
      // 도착정보에 남은 시간이 있으면 그걸 더 믿습니다 (열차번호로 맞춰봅니다)
      const hints = new Map<string, number>();
      for (const h of await fetchArrivalHints(station)) if (h.sec > 0) hints.set(h.trainNo, h.sec);

      const cands: typeof out = [];
      for (const t of pos.trains) {
        if (t.updn !== way) continue;
        // 급행 구간이면 급행만, 완행 구간이면 완행만 봅니다.
        // ⚠️ 완행 구간에 급행을 섞으면 안 됩니다 — 급행은 내릴 역을 지나칠 수 있습니다.
        //    (경로를 급행으로 잡는 게 나았다면 경로검색이 애초에 급행 구간으로 줬을 겁니다)
        if (expressKind ? !t.express : t.express) continue;
        const ti = ordered.indexOf(norm(t.station));
        if (ti < 0 || ti > boardIdx) continue; // 이미 지나간 열차
        // ⚠️ 우리 역 **앞에서 끝나는 열차**는 빼야 합니다.
        //    수인분당선에서 실제로 걸렸습니다 — 오리에 있는 죽전행(죽전에서 끝남)이
        //    보정 승차 후보로 잡혔습니다. 종점에 서 있는 열차(오이도의 오이도행)도 같은 경우입니다.
        //    ※ 순환선(2호선)은 행선지 번호로 앞뒤를 가릴 수 없어 이 검사를 건너뜁니다.
        if (!circular) {
          const di = ordered.indexOf(norm(t.dest));
          if (di >= 0 && di <= boardIdx) continue;
        }
        if (!reaches(t.dest)) continue; // 내릴 역까지 안 가는 열차
        // 지금 있는 역 → 우리 역까지 구간 시간을 더합니다
        let sec = 0;
        for (let i = ti; i < boardIdx; i++) sec += hopSec(line, ordered[i], ordered[i + 1]);
        sec += STATUS_ADJ[t.status] ?? 0;
        const hinted = hints.get(t.trainNo);
        cands.push({
          source: "live",
          etaSec: hinted ?? sec,
          min: nowMin + Math.round((hinted ?? sec) / 60),
          dest: t.dest,
          express: t.express,
          from: t.station,
          stops: boardIdx - ti,
          last: t.last,
        });
      }
      cands.sort((a, b) => (a.etaSec ?? 0) - (b.etaSec ?? 0));
      out.push(...cands.slice(0, want));
    }
  }

  // 모자라면 내장 시간표로 채웁니다.
  // (실시간으로 잡힌 마지막 열차보다 뒤에 있는 것만 넣어야 같은 열차가 두 번 나오지 않습니다)
  if (out.length < want) {
    const tt = await stationTimetable(station, line);
    if (tt) {
      const list = tt.lists[dayTypeOf()][way] ?? [];
      const afterMin = out.length ? out[out.length - 1].min + 1 : nowMin;
      for (const d of list) {
        if (d.min < afterMin) continue;
        // 실시간과 같은 기준으로 고릅니다 (급행 구간이면 급행만, 완행 구간이면 완행만)
        if (expressKind ? d.ex !== expressKind : !!d.ex) continue;
        if (!reaches(d.dest)) continue; // 내릴 역까지 안 가는 열차
        out.push({ source: "timetable", etaSec: null, min: d.min, dest: d.dest, express: !!d.ex });
        if (out.length >= want) break;
      }
    }
  }

  return Response.json({
    station,
    line,
    way,
    express: expressKind || null,
    live: pos.supported,
    liveReason: pos.supported ? null : pos.reason,
    updatedAt,
    nowMin,
    trains: out,
  });
}
