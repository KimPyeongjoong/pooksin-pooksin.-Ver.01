// 앱에 내장된 시간표 읽기
//
// 시간표는 1년에 두어 번 바뀌는 고정 데이터입니다. 예전에는 화면을 열 때마다
// ODsay에 물어봤는데, ODsay는 하루 호출 한도(무료 1,000건)가 있어 금방 바닥납니다.
// 이제 scripts/build-timetable.mjs 로 받아둔 파일을 읽어 씁니다 — 외부 호출 0건.
//
// 원본: 공공데이터포털 "서울교통공사_열차시간표" (15143847)
// 못 덮는 노선: 경의중앙 · 인천1 · 우이신설 → 이 노선만 ODsay로 넘깁니다.

import { shortLine } from "./line-colors";
import type { DayType } from "./holidays";
import { lineStations } from "./lines";

export type Departure = { min: number; dest: string };
export type Dirs = { up: Departure[]; down: Departure[] };

// 파일 안에서 시간표는 [자정기준 분, 행선지번호] 쌍으로 압축돼 있습니다.
type Pair = [number, number];
type LineTable = {
  line: string;
  built: string;
  dests: string[];
  stations: Record<string, { up?: Record<string, Pair[]>; down?: Record<string, Pair[]> }>;
};

// 번들러가 미리 알 수 있도록 노선마다 불러오는 함수를 적어둡니다.
// (경로를 변수로 만들면 번들에 포함되지 않아 배포 후 파일을 못 찾습니다.)
//
// 반환형을 unknown으로 둔 이유: JSON을 읽으면 TypeScript가 `[분, 행선지번호]` 쌍을
// 튜플이 아니라 그냥 숫자 배열로 봅니다. 아래 table()에서 한 번만 변환합니다.
const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  "GTX-A": () => import("./timetable/GTX-A.json"),
  "1호선": () => import("./timetable/1호선.json"),
  "2호선": () => import("./timetable/2호선.json"),
  "3호선": () => import("./timetable/3호선.json"),
  "4호선": () => import("./timetable/4호선.json"),
  "5호선": () => import("./timetable/5호선.json"),
  "6호선": () => import("./timetable/6호선.json"),
  "7호선": () => import("./timetable/7호선.json"),
  "8호선": () => import("./timetable/8호선.json"),
  "9호선": () => import("./timetable/9호선.json"),
  "수인분당선": () => import("./timetable/수인분당선.json"),
  "신분당선": () => import("./timetable/신분당선.json"),
  "공항철도": () => import("./timetable/공항철도.json"),
  "신림선": () => import("./timetable/신림선.json"),
  "서해선": () => import("./timetable/서해선.json"),
  "경춘선": () => import("./timetable/경춘선.json"),
  "경강선": () => import("./timetable/경강선.json"),
  "경의중앙선": () => import("./timetable/경의중앙선.json"),
  "인천1호선": () => import("./timetable/인천1호선.json"),
  "인천2호선": () => import("./timetable/인천2호선.json"),
  "김포골드라인": () => import("./timetable/김포골드라인.json"),
  "용인경전철": () => import("./timetable/용인경전철.json"),
  "의정부경전철": () => import("./timetable/의정부경전철.json"),
  "우이신설선": () => import("./timetable/우이신설선.json"),
};

export const COVERED_LINES = Object.keys(LOADERS);

export function isCovered(line: string): boolean {
  return !!LOADERS[shortLine(line)];
}

// 한 번 읽은 노선은 메모리에 둡니다 (파일이라 다시 읽어도 되지만 파싱 비용을 아낍니다).
const loaded = new Map<string, LineTable>();
async function table(line: string): Promise<LineTable | null> {
  const key = shortLine(line);
  const hit = loaded.get(key);
  if (hit) return hit;
  const load = LOADERS[key];
  if (!load) return null;
  const mod = await load();
  const t = mod.default as LineTable;
  loaded.set(key, t);
  return t;
}

// 역 이름 표기 차이 흡수.
//
// 자료마다 같은 역을 다르게 적습니다.
//   역 검색 목록: "서울"      / 공공 시간표: "서울역"
//   역 검색 목록: "사우"      / 노선도: "사우 (김포시청)"
//   노선도: "총신대입구(이수)"
// 그래서 공백·괄호·끝의 "역"을 떼고 비교합니다.
// (13개 노선 496개 역에 대해 이 규칙으로 이름이 겹치는 경우가 없음을 확인했습니다.)
// 그래도 안 맞는 두 곳은 따로 적어둡니다.
//   이수(7호선 시간표) = 총신대입구(4호선·노선도)  — 한 역을 노선마다 다르게 부릅니다
//   서해구청(노선도)   = 서구청(공식·시간표)        — 노선도 표기가 다릅니다
const NAME_ALIAS: Record<string, string> = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s: string) =>
  (s || "")
    .replace(/\s/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/역$/, "")
    .trim();
const norm = (s: string) => NAME_ALIAS[bare(s)] ?? bare(s);

// 앱은 평일 / 토요일 / 휴일 세 가지로 나누지만,
// 공공 시간표는 평일 / 주말 두 가지뿐입니다. 토요일·휴일은 같은 주말 시간표를 씁니다.
const DAY_KEY: Record<DayType, "wd" | "we"> = { weekday: "wd", sat: "we", sun: "we" };

// "이 역에서 저 역으로 가려면 상행인가 하행인가?" → 1=상행/외선, 2=하행/내선
//
// 경로를 직접 계산할 때(route-engine) 방향 코드를 만들 수 없어서 여기서 채웁니다.
// 방향을 모르면 "곧 오는 열차" 목록에 **반대 방향 열차**가 뜹니다.
// (5호선 종로3가에서 동대문역사문화공원으로 가는데 "방화행"이 뜨던 문제)
//
// 판단 방법: 그 방향 열차들의 행선지가 목적지 쪽에 있는지 봅니다.
export async function directionFor(
  line: string,
  from: string,
  to: string
): Promise<1 | 2 | null> {
  const t = await table(line);
  if (!t) return null;
  const order = lineStations(line).map(norm);
  const iFrom = order.indexOf(norm(from));
  const iTo = order.indexOf(norm(to));
  if (iFrom < 0 || iTo < 0 || iFrom === iTo) return null;
  const want = Math.sign(iTo - iFrom);

  const key = Object.keys(t.stations).find((k) => norm(k) === norm(from));
  if (!key) return null;
  const entry = t.stations[key];

  const scoreOf = (way: "up" | "down") => {
    let score = 0;
    for (const [, d] of entry[way]?.wd ?? []) {
      const i = order.indexOf(norm(t.dests[d] ?? ""));
      if (i >= 0 && i !== iFrom) score += Math.sign(i - iFrom) === want ? 1 : -1;
    }
    return score;
  };
  const up = scoreOf("up");
  const down = scoreOf("down");
  if (up === down) return null;
  return up > down ? 1 : 2;
}

export type StationTimetable = {
  line: string;
  built: string;
  upWay: string; // 상행 방면 대표 행선지
  downWay: string;
  lists: Record<DayType, Dirs>;
};

// 그 역의 시간표 전체(평일·토·휴일 × 상·하행). 못 덮는 노선이면 null.
export async function stationTimetable(
  station: string,
  line: string
): Promise<StationTimetable | null> {
  const t = await table(line);
  if (!t) return null;

  const want = norm(station);
  const key = Object.keys(t.stations).find((k) => norm(k) === want);
  if (!key) return null;
  const entry = t.stations[key];

  const pick = (way: "up" | "down", day: DayType): Departure[] =>
    (entry[way]?.[DAY_KEY[day]] ?? []).map(([min, d]) => ({ min, dest: t.dests[d] ?? "" }));

  const lists = {
    weekday: { up: pick("up", "weekday"), down: pick("down", "weekday") },
    sat: { up: pick("up", "sat"), down: pick("down", "sat") },
    sun: { up: pick("up", "sun"), down: pick("down", "sun") },
  } as Record<DayType, Dirs>;

  // 방면 이름은 그 방향에서 가장 많이 나오는 행선지로 정합니다.
  const common = (list: Departure[]) => {
    const n = new Map<string, number>();
    for (const d of list) if (d.dest) n.set(d.dest, (n.get(d.dest) ?? 0) + 1);
    let best = "";
    let max = 0;
    for (const [k, v] of n)
      if (v > max) {
        max = v;
        best = k;
      }
    return best;
  };

  let upWay = common(lists.weekday.up);
  let downWay = common(lists.weekday.down);
  // 순환선(2호선)은 양방향 열차가 모두 성수에서 끝나서 방면 이름이 똑같아집니다.
  // 그대로 두면 화면에 "성수 방면"이 두 개 나와 어느 쪽인지 알 수 없습니다.
  if (upWay && upWay === downWay) {
    const circular = /2호선/.test(t.line);
    upWay = `${upWay}(${circular ? "외선" : "상행"})`;
    downWay = `${downWay}(${circular ? "내선" : "하행"})`;
  }

  return { line: t.line, built: t.built, upWay, downWay, lists };
}
