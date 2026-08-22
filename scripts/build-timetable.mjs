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
// 커버: 수도권 24개 노선 **전부**.
//   처음엔 "경의중앙·인천1·우이신설은 없다"고 판단했는데, **이름을 잘못 물어본 것**이었습니다.
//   이 API는 앱과 다른 이름을 씁니다(아래 TARGETS 참조). 없다고 결론내기 전에 이름을 의심하세요.
//
// 같이 만드는 것: src/lib/section-times.json (역과 역 사이 소요시간, 초 단위)
//   경로검색을 직접 만들 때 쓰고, short-route.ts의 실행 중 API 호출도 없애 줍니다.
//
// 실행: (poogsin 폴더에서)
//   node scripts/build-timetable.mjs           전체
//   node scripts/build-timetable.mjs 5호선      한 노선만 (확인용)

import fs from "node:fs";
import path from "node:path";
import linemap from "../src/lib/linemap.json" with { type: "json" };

const API = "https://apis.data.go.kr/B553766/schedule/getTrainSch";
const OUT_DIR = path.join(process.cwd(), "src", "lib", "timetable");
const PAGE = 5000; // 이 API가 한 번에 주는 최대치 (10000을 넣으면 빈 응답이 옵니다)

// ── 수집 대상 ────────────────────────────────────────────────
// dir: 이 API가 쓰는 방향 이름 → 앱 규약(up = 상행·외선 / down = 하행·내선)
//
// 2호선만 방향이 네 가지입니다.
//   본선은 순환선이라 내선/외선, 지선(성수지선·신정지선)은 상행/하행으로 들어 있습니다.
//   지선 역(용답·신답·용두·신설동 / 도림천·양천구청·신정네거리·까치산)은 상·하행 쪽에만 있습니다.
// ⚠️ `lineNm`은 **부분일치**입니다. "2호선"으로 요청하면 **인천2호선이 먼저** 옵니다.
//    (2호선 상행 6,144행이 전부 인천2호선이었습니다.) 그래서 받은 뒤 lineNm이
//    정확히 일치하는 행만 남깁니다. `api`가 요청할 이름, `line`이 앱에서 쓰는 이름입니다.
//
// ⚠️ 이름이 앱과 다른 노선이 많습니다. 이름을 잘못 물어보면 "이 노선은 데이터가 없다"고
//    착각하게 됩니다. 실제로 처음엔 우이신설·경의중앙·인천1·김포를 그렇게 놓쳤습니다.
//      경의·중앙선 → "경의선"        인천1호선 → "인천선"
//      김포골드라인 → "김포도시철도"   우이신설선 → "우이신설경전철"
const TARGETS = [
  { api: "GTX-A", line: "GTX-A", dirs: { 상행: "up", 하행: "down" } },
  { api: "1호선", line: "1호선", dirs: { 상행: "up", 하행: "down" } },
  // 서울 2호선은 상행/하행 자료가 아예 없습니다. 본선·지선 모두 내선/외선에 들어 있습니다.
  { api: "2호선", line: "2호선", dirs: { 외선: "up", 내선: "down" } },
  { api: "3호선", line: "3호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "4호선", line: "4호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "5호선", line: "5호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "6호선", line: "6호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "7호선", line: "7호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "8호선", line: "8호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "9호선", line: "9호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "수인분당선", line: "수인분당선", dirs: { 상행: "up", 하행: "down" } },
  { api: "신분당선", line: "신분당선", dirs: { 상행: "up", 하행: "down" } },
  { api: "공항철도", line: "공항철도", dirs: { 상행: "up", 하행: "down" } },
  { api: "신림선", line: "신림선", dirs: { 상행: "up", 하행: "down" } },
  { api: "서해선", line: "서해선", dirs: { 상행: "up", 하행: "down" } },
  { api: "경춘선", line: "경춘선", dirs: { 상행: "up", 하행: "down" } },
  { api: "경강선", line: "경강선", dirs: { 상행: "up", 하행: "down" } },
  { api: "경의선", line: "경의중앙선", dirs: { 상행: "up", 하행: "down" } },
  { api: "인천선", line: "인천1호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "인천2호선", line: "인천2호선", dirs: { 상행: "up", 하행: "down" } },
  { api: "김포도시철도", line: "김포골드라인", dirs: { 상행: "up", 하행: "down" } },
  { api: "용인경전철", line: "용인경전철", dirs: { 상행: "up", 하행: "down" } },
  { api: "의정부경전철", line: "의정부경전철", dirs: { 상행: "up", 하행: "down" } },
  { api: "우이신설경전철", line: "우이신설선", dirs: { 상행: "up", 하행: "down" } },
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

async function fetchPage(key, api, dir, wknd, pageNo) {
  const qs = new URLSearchParams({
    numOfRows: String(PAGE),
    pageNo: String(pageNo),
    tmprTmtblYn: "N", // 임시 시간표 제외
    upbdnbSe: dir,
    wkndSe: wknd,
    lineNm: api,
  });
  const res = await fetch(`${API}?serviceKey=${key}&${qs}`);
  const text = await res.text();
  const code = tag(text, "resultCode");
  if (code && code !== "00") throw new Error(`API 오류 ${code}: ${tag(text, "resultMsg")}`);
  const total = Number(tag(text, "totalCount") || 0);
  const rows = [];
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const blk = m[1];
    // ⚠️ lineNm 부분일치 때문에 다른 노선이 섞여 옵니다. 정확히 일치하는 행만 씁니다.
    if (tag(blk, "lineNm") !== api) continue;
    const tm = tag(blk, "trainDptreTm");
    // ⚠️ 출발시각이 빈 행이 많습니다 — 그 역이 종착인 열차라 출발이 없습니다. 버립니다.
    if (!tm) continue;
    const min = toMin(tm);
    if (!Number.isFinite(min)) continue;
    // trainno는 "같은 열차가 이웃 역을 언제 출발하는지" 비교해 구간 소요시간을 뽑는 데 씁니다.
    const [hh, mm, ss] = String(tm).split(":").map(Number);
    const sec = (Number.isFinite(hh) ? hh : 0) * 3600 + (mm || 0) * 60 + (ss || 0);
    rows.push({ stn: tag(blk, "stnNm"), min, sec, dest: tag(blk, "arvlStnNm"), no: tag(blk, "trainno") });
  }
  return { rows, total };
}

async function collect(key, api, line, dir, wknd, log) {
  const out = [];
  let page = 1;
  let total = Infinity;
  while ((page - 1) * PAGE < total) {
    const { rows, total: t } = await fetchPage(key, api, dir, wknd, page);
    total = t;
    out.push(...rows);
    if (rows.length === 0 && page > 1) break; // 방어
    page++;
    if (page > 200) break; // 무한루프 방지
  }
  log(`   ${line} ${dir} ${wknd}: ${total}행 → 출발시각 있는 ${out.length}행`);
  return out;
}

// ── 구간 소요시간 뽑기 ───────────────────────────────────────
//
// 경로검색을 직접 만들려면 "이 역에서 다음 역까지 몇 분"이 필요합니다.
// 시간표에는 그 값이 없지만, **같은 열차번호**가 이웃한 두 역을 출발한 시각을 빼면 구할 수 있습니다.
//   예) 열차 5031이 종로3가 08:00, 을지로4가 08:02 출발 → 2분
// 열차마다 조금씩 다르므로 가장 많이 나온 값(최빈값)을 씁니다.
//
// 이 값이 있으면 (1) 경로검색을 직접 만들 수 있고
//               (2) short-route.ts가 실행 중에 API를 부르지 않아도 됩니다.
// 노선도에서 "실제로 이웃한 역" 쌍을 만들어 둡니다.
//
// ⚠️ 이게 없으면 급행 열차 때문에 엉뚱한 구간이 만들어집니다.
//    급행은 역을 건너뛰므로 정차역만 이어보면 "서울역 → 구로"처럼 이웃이 아닌 쌍이 생기고,
//    그 시간이 인접 구간 시간으로 둔갑합니다. (1호선에서 구간이 1148개나 나왔던 원인)
const LINEMAP_NAME = {
  신림선: "신림",
  서해선: "서해",
  우이신설선: "우이신설경전철",
  경의중앙선: "경의·중앙선",
};
// 역 이름 정규화 — 자료마다 표기가 다릅니다.
//   노선도 "관악산(서울대)"  ↔  시간표 "관악산"
//   노선도 "사우 (김포시청)" ↔  검색목록 "사우"
//   검색목록 "서울"          ↔  시간표 "서울역"
// 공백·괄호·끝의 "역"을 떼고 비교합니다. (src/lib/timetable.ts 와 같은 규칙)
const NAME_ALIAS = { 이수: "총신대입구" }; // 4호선은 총신대입구, 7호선 시간표는 이수로 부릅니다
const nn = (s) =>
  NAME_ALIAS[rawNn(s)] ?? rawNn(s);
const rawNn = (s) =>
  (s || "")
    .replace(/\s/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/역$/, "")
    .trim();
function adjacentPairs(line) {
  const label = LINEMAP_NAME[line] ?? line;
  const l = linemap.find((x) => nn(x.label) === nn(label));
  const set = new Set();
  if (!l) return set;
  let prev = null;
  for (const n of l.nodes) {
    if (n.m) prev = null; // 선이 끊기는 지점에서는 이어지지 않습니다
    if (!n.name) continue;
    if (prev) {
      set.add(`${nn(prev)}|${nn(n.name)}`);
      set.add(`${nn(n.name)}|${nn(prev)}`);
    }
    prev = n.name;
  }
  return set;
}

function addSectionTimes(rows, acc, adj) {
  // 열차번호별로 "출발시각 순서"대로 늘어놓습니다.
  const byTrain = new Map();
  for (const r of rows) {
    if (!r.no || !r.stn) continue;
    if (!byTrain.has(r.no)) byTrain.set(r.no, []);
    byTrain.get(r.no).push(r);
  }
  for (const stops of byTrain.values()) {
    stops.sort((a, b) => a.sec - b.sec);
    for (let i = 0; i + 1 < stops.length; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const k = `${nn(a.stn)}|${nn(b.stn)}`;
      // 노선도상 실제 이웃이 아니면 버립니다 (급행이 건너뛴 구간 등)
      if (!adj.has(k)) continue;
      // 초 단위로 계산합니다. 분으로 잘라 쓰면 08:00:50 → 08:01:40 이 "1분"이 되어
      // 실제 2분 구간이 1분으로 나옵니다 (강남→역삼에서 실제로 그랬습니다).
      const d = b.sec - a.sec;
      if (d <= 0 || d > 15 * 60) continue; // 0이나 비정상으로 긴 값은 자료 오류
      if (!acc.has(k)) acc.set(k, new Map());
      const tally = acc.get(k);
      tally.set(d, (tally.get(d) ?? 0) + 1);
    }
  }
}

// 최빈값만 남겨 { "종로3가|을지로4가": 128 } 형태로 (단위: 초)
// 초로 저장해야 여러 구간을 더할 때 오차가 쌓이지 않습니다.
function pickModes(acc) {
  const out = {};
  for (const [k, tally] of acc) {
    let best = 0;
    let max = 0;
    for (const [d, n] of tally)
      if (n > max) {
        max = n;
        best = d;
      }
    if (best) out[k] = best;
  }
  return out;
}

// ── 본체 ────────────────────────────────────────────────────
async function main() {
  const only = process.argv[2] || null;
  const key = apiKey();
  const targets = only ? TARGETS.filter((t) => t.line === only || t.api === only) : TARGETS;
  if (!targets.length) throw new Error(`'${only}' 는 이 API가 제공하지 않는 노선입니다`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const built = new Date().toISOString().slice(0, 10);
  const index = [];

  for (const { api, line, dirs } of targets) {
    console.log(`■ ${line}`);
    // stations[역명][up|down][wd|we] = Set("min|dest")
    const stations = new Map();
    const sectionAcc = new Map(); // "A|B" → Map(소요초 → 몇 번 나왔나)
    const adj = adjacentPairs(line); // 노선도상 실제 이웃 쌍
    // 2호선에서 본선 데이터가 이미 담긴 역 (지선이 덮어쓰지 않게)
    const fromMain = new Set();

    for (const [dir, way] of Object.entries(dirs)) {
      for (const [wknd, dayKey] of Object.entries(DAYS)) {
        const rows = await collect(key, api, line, dir, wknd, console.log);
        addSectionTimes(rows, sectionAcc, adj);
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

    // 구간 소요시간은 한 파일에 모읍니다 (노선 하나만 다시 받아도 나머지는 남기려고 병합)
    const secFile = path.join(path.dirname(OUT_DIR), "section-times.json");
    const prev = fs.existsSync(secFile) ? JSON.parse(fs.readFileSync(secFile, "utf8")) : { built, lines: {} };
    prev.built = built;
    prev.lines[line] = pickModes(sectionAcc);
    fs.writeFileSync(secFile, JSON.stringify(prev));
    console.log(`  → section-times.json  ${line} 구간 ${Object.keys(prev.lines[line]).length}개`);
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
