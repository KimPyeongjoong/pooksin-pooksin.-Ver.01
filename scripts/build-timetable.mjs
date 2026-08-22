// 지하철 시간표 수집 스크립트 (시간표가 개정되면 다시 실행하면 됩니다)
//
// 왜 필요한가:
//   시간표는 1년에 두어 번 바뀌는 "고정 데이터"인데, 지금까지는 화면을 열 때마다
//   ODsay에 물어봤습니다. ODsay는 하루 호출 한도(무료 1,000건)가 있어서
//   조금만 써도 바닥납니다. 한 번 받아 파일로 굳혀두면 런타임 호출이 0건이 됩니다.
//
// 출처: 공공데이터포털 "서울교통공사_열차시간표" (15143847)
//   https://apis.data.go.kr/B553766/schedule/getTrainSch
//   키: .env.local 의 SEOUL_METRO_API_KEY (URL 인코딩된 형태 그대로 사용)
//
// 커버 못 하는 노선: 경의중앙 · 인천1 · 우이신설 (이 API에 아예 없음)
//   → 그 세 노선만 기존대로 ODsay로 조회합니다.
//
// 실행: (poogsin 폴더에서)
//   node scripts/build-timetable.mjs           전체
//   node scripts/build-timetable.mjs 5호선      한 노선만 (확인용)

import fs from "node:fs";
import path from "node:path";

const API = "https://apis.data.go.kr/B553766/schedule/getTrainSch";
const OUT_DIR = path.join(process.cwd(), "src", "lib", "timetable");
const PAGE = 5000; // 이 API가 한 번에 주는 최대치 (10000을 넣으면 빈 응답이 옵니다)

// ── 수집 대상 ────────────────────────────────────────────────
// dir: 이 API가 쓰는 방향 이름 → 앱 규약(up = 상행·외선 / down = 하행·내선)
//
// 2호선만 방향이 네 가지입니다.
//   본선은 순환선이라 내선/외선, 지선(성수지선·신정지선)은 상행/하행으로 들어 있습니다.
//   지선 역(용답·신답·용두·신설동 / 도림천·양천구청·신정네거리·까치산)은 상·하행 쪽에만 있습니다.
const TARGETS = [
  { line: "1호선", dirs: { 상행: "up", 하행: "down" } },
  { line: "2호선", dirs: { 외선: "up", 내선: "down", 상행: "up", 하행: "down" } },
  { line: "3호선", dirs: { 상행: "up", 하행: "down" } },
  { line: "4호선", dirs: { 상행: "up", 하행: "down" } },
  { line: "5호선", dirs: { 상행: "up", 하행: "down" } },
  { line: "6호선", dirs: { 상행: "up", 하행: "down" } },
  { line: "7호선", dirs: { 상행: "up", 하행: "down" } },
  { line: "8호선", dirs: { 상행: "up", 하행: "down" } },
  { line: "9호선", dirs: { 상행: "up", 하행: "down" } },
  { line: "수인분당선", dirs: { 상행: "up", 하행: "down" } },
  { line: "신분당선", dirs: { 상행: "up", 하행: "down" } },
  { line: "공항철도", dirs: { 상행: "up", 하행: "down" } },
  { line: "신림선", dirs: { 상행: "up", 하행: "down" } },
];

// 2호선 본선 우선 처리를 위해, 본선 방향 이름을 따로 알아둡니다.
const MAIN_DIRS = new Set(["외선", "내선"]);

const DAYS = { 평일: "wd", 주말: "we" };

// ── 유틸 ────────────────────────────────────────────────────
function apiKey() {
  const env = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(/SEOUL_METRO_API_KEY=(.*)/);
  if (!m) throw new Error(".env.local 에 SEOUL_METRO_API_KEY 가 없습니다");
  return m[1].trim();
}

const tag = (blk, k) => (blk.match(new RegExp(`<${k}>([^<]*)</${k}>`)) || [])[1] ?? "";

// "06:01:40" → 361 (자정 기준 분). 심야편은 "24:15:00"처럼 와서 1440을 넘습니다.
//
// ⚠️ 1호선은 자정 넘은 열차를 "24:00"과 "00:00" 두 가지로 **둘 다** 넣어 보냅니다.
//    그대로 두면 같은 열차가 시간표 맨 앞(00:00)과 맨 뒤(24:00)에 두 번 나옵니다.
//    첫차가 05:15보다 이른 노선은 없으므로, 04시 이전은 전날 심야편으로 보고 24시간을 더해
//    24:00 쪽과 같은 값으로 만들어 중복을 없앱니다.
function toMin(hhmmss) {
  const [h, m] = String(hhmmss).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  const min = h * 60 + m;
  return min < 4 * 60 ? min + 24 * 60 : min;
}

async function fetchPage(key, line, dir, wknd, pageNo) {
  const qs = new URLSearchParams({
    numOfRows: String(PAGE),
    pageNo: String(pageNo),
    tmprTmtblYn: "N", // 임시 시간표 제외
    upbdnbSe: dir,
    wkndSe: wknd,
    lineNm: line,
  });
  const res = await fetch(`${API}?serviceKey=${key}&${qs}`);
  const text = await res.text();
  const code = tag(text, "resultCode");
  if (code && code !== "00") throw new Error(`API 오류 ${code}: ${tag(text, "resultMsg")}`);
  const total = Number(tag(text, "totalCount") || 0);
  const rows = [];
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const blk = m[1];
    const tm = tag(blk, "trainDptreTm");
    // ⚠️ 출발시각이 빈 행이 많습니다 — 그 역이 종착인 열차라 출발이 없습니다. 버립니다.
    if (!tm) continue;
    const min = toMin(tm);
    if (!Number.isFinite(min)) continue;
    rows.push({ stn: tag(blk, "stnNm"), min, dest: tag(blk, "arvlStnNm") });
  }
  return { rows, total };
}

async function collect(key, line, dir, wknd, log) {
  const out = [];
  let page = 1;
  let total = Infinity;
  while ((page - 1) * PAGE < total) {
    const { rows, total: t } = await fetchPage(key, line, dir, wknd, page);
    total = t;
    out.push(...rows);
    if (rows.length === 0 && page > 1) break; // 방어
    page++;
    if (page > 200) break; // 무한루프 방지
  }
  log(`   ${line} ${dir} ${wknd}: ${total}행 → 출발시각 있는 ${out.length}행`);
  return out;
}

// ── 본체 ────────────────────────────────────────────────────
async function main() {
  const only = process.argv[2] || null;
  const key = apiKey();
  const targets = only ? TARGETS.filter((t) => t.line === only) : TARGETS;
  if (!targets.length) throw new Error(`'${only}' 는 이 API가 제공하지 않는 노선입니다`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const built = new Date().toISOString().slice(0, 10);
  const index = [];

  for (const { line, dirs } of targets) {
    console.log(`■ ${line}`);
    // stations[역명][up|down][wd|we] = Set("min|dest")
    const stations = new Map();
    // 2호선에서 본선 데이터가 이미 담긴 역 (지선이 덮어쓰지 않게)
    const fromMain = new Set();

    for (const [dir, way] of Object.entries(dirs)) {
      for (const [wknd, dayKey] of Object.entries(DAYS)) {
        const rows = await collect(key, line, dir, wknd, console.log);
        for (const r of rows) {
          if (!r.stn) continue;
          // 2호선: 본선(내선·외선)에 있는 역은 지선(상·하행)으로 덮어쓰지 않습니다.
          // 신도림·성수는 양쪽에 다 나오는데, 기본은 본선이 맞습니다.
          const isMain = MAIN_DIRS.has(dir);
          if (isMain) fromMain.add(r.stn);
          else if (fromMain.has(r.stn)) continue;

          if (!stations.has(r.stn)) stations.set(r.stn, { up: {}, down: {} });
          const slot = stations.get(r.stn)[way];
          if (!slot[dayKey]) slot[dayKey] = new Set();
          // ⚠️ 같은 열차가 'S' 접두 번호로 한 번 더 들어옵니다 (4301 / S4301).
          //    시각+종착으로 묶어 중복을 없앱니다.
          slot[dayKey].add(`${r.min}|${r.dest}`);
        }
      }
    }

    // 행선지 이름을 따로 모아 번호로 참조합니다 (파일 크기 절약)
    const dests = [];
    const destIdx = new Map();
    const idOf = (d) => {
      if (!destIdx.has(d)) {
        destIdx.set(d, dests.length);
        dests.push(d);
      }
      return destIdx.get(d);
    };

    const outStations = {};
    for (const [stn, ways] of stations) {
      const o = {};
      for (const way of ["up", "down"]) {
        const byDay = {};
        for (const [dayKey, set] of Object.entries(ways[way])) {
          const list = [...set]
            .map((s) => {
              const i = s.indexOf("|");
              return [Number(s.slice(0, i)), idOf(s.slice(i + 1))];
            })
            .sort((a, b) => a[0] - b[0]);
          if (list.length) byDay[dayKey] = list;
        }
        if (Object.keys(byDay).length) o[way] = byDay;
      }
      if (Object.keys(o).length) outStations[stn] = o;
    }

    const file = path.join(OUT_DIR, `${line}.json`);
    fs.writeFileSync(file, JSON.stringify({ line, built, dests, stations: outStations }));
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`  → ${line}.json  역 ${Object.keys(outStations).length}개 · ${kb}KB\n`);
    index.push({ line, stations: Object.keys(outStations).length, kb });
  }

  if (!only) {
    fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify({ built, lines: index }, null, 2));
    const totalKb = index.reduce((s, x) => s + x.kb, 0);
    console.log(`완료: ${index.length}개 노선 · 합계 ${totalKb}KB`);
  }
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
