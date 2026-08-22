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

// 역 이름 표기 차이 흡수 ("사우 (김포시청)" ↔ "사우(김포시청)")
const norm = (s: string) => (s || "").replace(/\s/g, "");

// 앱은 평일 / 토요일 / 휴일 세 가지로 나누지만,
// 공공 시간표는 평일 / 주말 두 가지뿐입니다. 토요일·휴일은 같은 주말 시간표를 씁니다.
const DAY_KEY: Record<DayType, "wd" | "we"> = { weekday: "wd", sat: "we", sun: "we" };

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

  return {
    line: t.line,
    built: t.built,
    upWay: common(lists.weekday.up),
    downWay: common(lists.weekday.down),
    lists,
  };
}
