// 지하철 시간표 + 급행 수집 스크립트 (시간표가 개정되면 다시 실행하면 됩니다)
//
// 왜 필요한가:
//   시간표는 1년에 두어 번 바뀌는 "고정 데이터"입니다. 한 번 받아 파일로 굳혀두면
//   화면을 열 때마다 외부 API를 부를 필요가 없어집니다(런타임 호출 0건).
//
// 출처: 공공데이터포털 "서울교통공사_열차시간표" (15143847)
//   https://apis.data.go.kr/B553766/schedule/getTrainSch
//   키: .env.local 의 SEOUL_METRO_API_KEY (URL 인코딩된 형태 그대로 사용)
//
// 커버: 수도권 24개 노선 **전부**.
//   처음엔 "경의중앙·인천1·우이신설은 없다"고 판단했는데, **이름을 잘못 물어본 것**이었습니다.
//   이 API는 앱과 다른 이름을 씁니다(아래 TARGETS 참조). 없다고 결론내기 전에 이름을 의심하세요.
//
// 만드는 파일 세 가지:
//   ① src/lib/timetable/{노선}.json  — 역별 출발시각 (급행 표시 포함)
//   ② src/lib/section-times.json     — 역과 역 사이 소요시간(초)
//   ③ src/lib/express.json           — 급행이 어디에 서는지 + 급행 구간 소요시간
//
// 실행: (poogsin 폴더에서)
//   node scripts/build-timetable.mjs                  전체
//   node scripts/build-timetable.mjs 1호선             한 노선만
//   node scripts/build-timetable.mjs 1호선 --report    파일은 안 쓰고 분석 결과만 출력
//
// ─────────────────────────────────────────────────────────────
// ⭐ 이 자료에서 급행을 알아내는 방법 (2026-08-23 확인)
//
//   원본에는 급행이 **처음부터 들어 있습니다.** 열차마다 역별로 한 줄씩 있는데,
//     · 서는 역   → `trainArvlTm`(도착시각)이 **있습니다**
//     · 지나는 역 → `trainArvlTm`이 **비어 있습니다** (지나가니까 도착이 없음)
//   ⚠️ `trainDptreTm`(출발시각)은 **통과역에도 적혀 있습니다.**
//      그래서 출발시각만 보면 급행이 모든 역에 서는 것처럼 보입니다. 이게 함정이었습니다.
//
//   예외 둘:
//     · 그 열차가 **출발하는 역**도 도착시각이 없습니다(거기서 시작하니까) → 정차로 봅니다.
//     · 9호선처럼 통과역 줄을 아예 **안 주는** 노선도 있습니다 → 노선도에서 사이 역을 찾아 채웁니다.
//
// ⭐ 유효기간(vldBgngDt·vldEndDt)을 반드시 걸러야 합니다 (2026-08-23 확인)
//   이 API는 **지난 개정판 시간표까지 전부** 함께 보냅니다.
//   1호선 상행 평일은 72,407행이 오는데 지금 유효한 것은 15,417행(개정 6판 중 1판)뿐입니다.
//   안 거르면 옛날 열차가 시간표에 섞여 한 역에 열차가 5배로 나오고, 급행 판별도 뒤섞입니다.
//
//   덤: 유효기간을 거르면 **열차번호 중복이 사라집니다.**
//       (예전에 "열차번호가 재사용된다"고 본 것은 여러 개정판이 겹쳐 보였던 것입니다.
//        1호선 407대·9호선 246대 모두 같은 역이 두 번 나오는 열차가 0대였습니다.)

import fs from "node:fs";
import path from "node:path";
import linemap from "../src/lib/linemap.json" with { type: "json" };

const API = "https://apis.data.go.kr/B553766/schedule/getTrainSch";
const OUT_DIR = path.join(process.cwd(), "src", "lib", "timetable");
const SEC_FILE = path.join(process.cwd(), "src", "lib", "section-times.json");
const EXPRESS_FILE = path.join(process.cwd(), "src", "lib", "express.json");
const PAGE = 5000; // 이 API가 한 번에 주는 최대치 (10000을 넣으면 빈 응답이 옵니다)

// ── 수집 대상 ────────────────────────────────────────────────
// dir: 이 API가 쓰는 방향 이름 → 앱 규약(up = 상행·외선 / down = 하행·내선)
//
// 2호선만 방향이 네 가지입니다.
//   본선은 순환선이라 내선/외선, 지선(성수지선·신정지선)은 상행/하행으로 들어 있습니다.
// ⚠️ `lineNm`은 **부분일치**입니다. "2호선"으로 요청하면 **인천2호선이 먼저** 옵니다.
//    그래서 받은 뒤 lineNm이 정확히 일치하는 행만 남깁니다.
// ⚠️ 이름이 앱과 다른 노선이 많습니다(경의·중앙선 → "경의선", 인천1호선 → "인천선" 등).
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

// 지금 시각을 "2026-08-23T12:00:00" 모양으로 (유효기간 문자열과 그대로 비교하려고)
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

// "06:01:40" → 361 (자정 기준 분). 심야편은 "24:15:00"처럼 와서 1440을 넘습니다.
//
// ⚠️ 1호선은 자정 넘은 열차를 "24:00"과 "00:00" 두 가지로 **둘 다** 넣어 보냅니다.
//    첫차가 05:15보다 이른 노선은 없으므로, 04시 이전은 전날 심야편으로 보고 24시간을 더합니다.
function toMin(hhmmss) {
  const [h, m] = String(hhmmss).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  const min = h * 60 + m;
  return min < 4 * 60 ? min + 24 * 60 : min;
}
function toSec(hhmmss) {
  const [h, m, s] = String(hhmmss).split(":").map(Number);
  if (!Number.isFinite(h)) return NaN;
  const sec = h * 3600 + (m || 0) * 60 + (s || 0);
  return sec < 4 * 3600 ? sec + 24 * 3600 : sec;
}

// ── 역 이름 정규화 ───────────────────────────────────────────
// 자료마다 표기가 다릅니다. 노선도 "관악산(서울대)" ↔ 시간표 "관악산",
// 검색목록 "서울" ↔ 시간표 "서울역". 공백·괄호·끝의 "역"을 떼고 비교합니다.
// (src/lib/timetable.ts 와 같은 규칙)
//   이수(7호선 시간표) = 총신대입구(4호선·노선도)
//   서해구청(노선도)   = 서구청(공식·시간표)
// 가운뎃점도 자료마다 다릅니다 — 노선도 "시청·용인대" ↔ 시간표 "시청.용인대" → 둘 다 떼어냅니다.
const NAME_ALIAS = { 이수: "총신대입구", 서해구청: "서구청" };
const rawNn = (s) =>
  (s || "")
    .replace(/\s/g, "")
    .replace(/[·.]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/역$/, "")
    .trim();
const nn = (s) => NAME_ALIAS[rawNn(s)] ?? rawNn(s);

const LINEMAP_NAME = {
  신림선: "신림",
  서해선: "서해",
  우이신설선: "우이신설경전철",
  경의중앙선: "경의·중앙선",
};

// ── 원본 받기 ────────────────────────────────────────────────
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
    const dep = tag(blk, "trainDptreTm");
    const arr = tag(blk, "trainArvlTm");
    if (!dep && !arr) continue; // 둘 다 없으면 쓸 데가 없습니다
    rows.push({
      no: tag(blk, "trainno"),
      stn: tag(blk, "stnNm"),
      org: tag(blk, "dptreStnNm"), // 이 열차가 출발하는 역
      dest: tag(blk, "arvlStnNm"), // 종착역(= 행선지)
      brln: tag(blk, "brlnNm"), // 지선 이름 (경인선·경부선·서울급행 등)
      dep,
      arr,
      depSec: dep ? toSec(dep) : null,
      arrSec: arr ? toSec(arr) : null,
      min: dep ? toMin(dep) : NaN,
      vb: tag(blk, "vldBgngDt"), // 이 시간표가 적용되기 시작한 때
      ve: tag(blk, "vldEndDt"), //  적용이 끝난 때 (비어 있으면 지금도 유효)
    });
  }
  return { rows, total };
}

// ⭐ 지금 유효한 개정판만 남깁니다 (이 스크립트에서 가장 중요한 부분).
function pickValid(rows, now, log) {
  if (!rows.length) return rows;
  const ok = rows.filter((r) => (!r.vb || r.vb <= now) && (!r.ve || r.ve >= now));
  if (ok.length) return ok;
  // 지금 유효한 개정이 하나도 없으면(자료가 오래된 노선) 가장 최근 개정을 씁니다.
  const groups = new Map();
  for (const r of rows) {
    const k = r.vb || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort();
  const past = keys.filter((k) => !k || k <= now);
  const use = past.length ? past[past.length - 1] : keys[keys.length - 1];
  log(`      ⚠️ 지금 유효한 개정이 없어 가장 최근(${use || "기간 표시 없음"}) 것을 씁니다`);
  return groups.get(use);
}

async function collect(key, api, line, dir, wknd, now, log) {
  const all = [];
  let page = 1;
  let total = Infinity;
  while ((page - 1) * PAGE < total) {
    const { rows, total: t } = await fetchPage(key, api, dir, wknd, page);
    total = t;
    all.push(...rows);
    if (rows.length === 0 && page > 1) break; // 방어
    page++;
    if (page > 200) break; // 무한루프 방지
  }
  const valid = pickValid(all, now, log);
  const versions = new Set(all.map((r) => r.vb)).size;
  log(
    `   ${line} ${dir} ${wknd}: ${total}행 → 지금 유효한 ${valid.length}행` +
      (versions > 1 ? ` (개정 ${versions}판 중 1판)` : "")
  );
  return valid;
}

// ── 노선도에서 역 이웃 관계 ──────────────────────────────────
//
// "이 역 다음이 저 역"을 알아야 급행이 몇 개 역을 건너뛰었는지 셀 수 있고,
// 구간 소요시간을 만들 때 엉뚱한 쌍(급행이 건너뛴 구간)을 버릴 수 있습니다.
//
// ⚠️ 순환선(2호선)은 한 바퀴를 돌아 첫 역 자리로 되돌아오며 끝나는데,
//    그 마지막 노드에는 **이름이 없습니다**. 같은 좌표에 있는 이름 없는 노드를 그 역으로 봅니다.
function neighborsOf(line) {
  const label = LINEMAP_NAME[line] ?? line;
  const l = linemap.find((x) => nn(x.label) === nn(label));
  const map = new Map();
  if (!l) return map;
  const nameAt = new Map();
  for (const n of l.nodes) if (n.name) nameAt.set(`${n.x},${n.y}`, n.name);
  const link = (a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  };
  let prev = null;
  for (const n of l.nodes) {
    if (n.m) prev = null; // 선이 끊기는 지점에서는 이어지지 않습니다
    const name = n.name ?? nameAt.get(`${n.x},${n.y}`);
    if (!name) continue;
    const cur = nn(name);
    if (prev && prev !== cur) link(prev, cur);
    prev = cur;
  }
  return map;
}

const isAdjacent = (nb, a, b) => !!nb.get(a)?.has(b);

// 두 역 사이에 낀 역들(= 건너뛴 역)을 노선도에서 찾습니다.
// 이웃이면 [], 못 찾으면 null. (지선이 있어도 맞도록 최단경로로 찾습니다)
function stationsBetween(nb, a, b, maxHop = 14) {
  if (a === b) return null;
  if (!nb.has(a) || !nb.has(b)) return null;
  const prev = new Map([[a, null]]);
  let frontier = [a];
  for (let hop = 0; hop < maxHop && frontier.length; hop++) {
    const next = [];
    for (const cur of frontier) {
      for (const nx of nb.get(cur) ?? []) {
        if (prev.has(nx)) continue;
        prev.set(nx, cur);
        if (nx === b) {
          const out = [];
          let p = prev.get(b);
          while (p && p !== a) {
            out.unshift(p);
            p = prev.get(p);
          }
          return out;
        }
        next.push(nx);
      }
    }
    frontier = next;
  }
  return null;
}

// ── 한 열차의 운행(run) 만들기 ───────────────────────────────
//
// 유효기간을 거르면 열차번호가 겹치지 않지만, 혹시 모르니
// 같은 역이 두 번 나오거나 40분 넘게 비면 다른 운행으로 끊습니다.
function runsOf(rows) {
  const byNo = new Map();
  for (const r of rows) {
    if (!r.no || !r.stn) continue;
    r.t = r.arrSec ?? r.depSec; // 그 역에 닿는 시각
    r.tOut = r.depSec ?? r.arrSec; // 그 역을 떠나는 시각
    if (!Number.isFinite(r.t)) continue;
    if (!byNo.has(r.no)) byNo.set(r.no, []);
    byNo.get(r.no).push(r);
  }
  const runs = [];
  for (const rs of byNo.values()) {
    rs.sort((a, b) => a.t - b.t);
    let cur = [];
    let seen = new Set();
    for (const r of rs) {
      const k = nn(r.stn);
      if (cur.length && (seen.has(k) || r.t - cur[cur.length - 1].t > 40 * 60)) {
        if (cur.length >= 2) runs.push(cur);
        cur = [];
        seen = new Set();
      }
      cur.push(r);
      seen.add(k);
    }
    if (cur.length >= 2) runs.push(cur);
  }
  return runs;
}

// ⚠️ 원본이 한 칸씩 밀려 오는 자료가 있습니다 (2026-08-23 확인)
//
//   1호선 **상행 주말 급행 75대**가 그렇습니다. 역 이름과 시각이 한 칸 어긋나서,
//   그대로 읽으면 급행이 도원·도화·간석에 서고 부평·부천을 통과하는 것으로 나옵니다.
//   (경인선 급행은 그 역들에 승강장 자체가 없어 물리적으로 불가능합니다.)
//
//   알아내는 법: 시각순으로 늘어놓았을 때 **마지막이 아닌 줄에 도착만 있고 출발이 없으면** 어긋난 것입니다.
//     (정상이라면 도착만 있는 줄은 종착역 하나뿐입니다.)
//   고치는 법: 시각을 한 칸 뒤로 옮깁니다 — 둘째 역이 첫 줄의 시각을 갖도록. 맨 앞 역과 맨 뒤 시각은 버립니다.
//   검증: 이렇게 고친 상행 주말 급행의 부천→구로가 11.5분으로,
//         멀쩡한 하행 주말 급행(11.4분)·평일 급행(11.4분)과 일치합니다.
//         (안 고치면 13.4분 — 완행 16분과 급행 11.4분 사이의 있지도 않은 값)
//   고쳐도 모양이 안 맞으면 그 운행은 통째로 버립니다. 추측하지 않습니다.
function fixMisaligned(run) {
  const off = (rs) => rs.findIndex((r, i) => i < rs.length - 1 && r.arr && !r.dep);
  if (off(run) < 0) return run;
  const fixed = [];
  for (let i = 1; i < run.length; i++) {
    const s = run[i]; // 역 이름은 이 줄 것
    const t = run[i - 1]; // 시각은 앞 줄 것
    fixed.push({
      ...s,
      dep: t.dep,
      arr: t.arr,
      depSec: t.depSec,
      arrSec: t.arrSec,
      min: t.min,
      t: t.arrSec ?? t.depSec,
      tOut: t.depSec ?? t.arrSec,
    });
  }
  if (!fixed.length || off(fixed) >= 0) return null;
  return fixed;
}

// ⭐ 이 운행이 어디에 서고 어디를 지나쳤는지
function runInfo(run, nb) {
  const seq = run.map((r) => ({
    name: nn(r.stn),
    // 도착시각이 있으면 정차. 출발역은 도착시각이 없지만 정차입니다.
    stop: !!r.arr || nn(r.stn) === nn(r.org),
    out: r.tOut,
  }));
  const stops = seq.filter((s) => s.stop);
  const skips = new Set(seq.filter((s) => !s.stop).map((s) => s.name)); // 통과 기록이 있는 역
  const edges = [];
  let unknown = 0;
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a.name === b.name) continue;
    const sec = b.out - a.out; // 완행 구간표와 같은 기준(출발 → 출발)
    if (sec <= 0 || sec > 40 * 60) continue;
    if (isAdjacent(nb, a.name, b.name)) {
      edges.push({ a: a.name, b: b.name, sec });
      continue;
    }
    // 이웃이 아니면 사이 역을 건너뛴 것입니다 (9호선처럼 통과역 줄이 없는 노선용)
    const between = stationsBetween(nb, a.name, b.name);
    if (between === null) {
      unknown++; // 노선도에서 길을 못 찾음 — 판단 보류
      continue;
    }
    for (const m of between) skips.add(m);
    edges.push({ a: a.name, b: b.name, sec });
  }
  return {
    stops: stops.map((s) => s.name),
    skips,
    edges,
    unknown,
    express: skips.size > 0,
    brln: run[0]?.brln ?? "",
  };
}

// ── 급행 갈래(서비스) 묶기 ───────────────────────────────────
//
// 같은 노선에도 급행이 여러 갈래입니다. 1호선만 해도
//   경인급행(동인천~용산) · 경인특급(더 많이 건너뜀) · 경부급행(신창~청량리)
// 이 셋이 따로 다닙니다. 하나로 합치면 "동인천에서 천안까지 급행 한 번에" 같은
// 있지도 않은 열차가 만들어집니다.
//
// 묶는 규칙: 서는 역도 부분집합이고 건너뛰는 역도 부분집합일 때만 같은 갈래로 봅니다.
//   · 중간에서 시작·끝나는 짧은 운행(동인천→구로)은 긴 운행(동인천→용산)에 흡수됩니다.
//   · 특급은 서는 역은 급행의 부분집합이지만 **건너뛰는 역이 더 많아** 따로 남습니다.
const isSubset = (small, big) => {
  for (const v of small) if (!big.has(v)) return false;
  return true;
};

function buildServices(runs) {
  // 같은 정차 패턴끼리 먼저 뭉칩니다
  const pats = new Map();
  for (const r of runs) {
    if (!r.info.express) continue;
    const stops = [...new Set(r.info.stops)].sort();
    const skips = [...r.info.skips].sort();
    const key = stops.join(">") + "//" + skips.join(">");
    if (!pats.has(key))
      pats.set(key, {
        stopSet: new Set(stops),
        skipSet: new Set(skips),
        n: 0,
        edges: [],
        brln: new Map(),
        ends: new Map(),
        days: new Map(),
        ways: new Set(),
        runs: [],
      });
    const p = pats.get(key);
    p.n++;
    p.edges.push(...r.info.edges);
    // 이 갈래가 어디서 어디까지 다니는지 — 운행의 첫 역·끝 역을 세어 둡니다
    for (const e of [r.info.stops[0], r.info.stops[r.info.stops.length - 1]])
      if (e) p.ends.set(e, (p.ends.get(e) ?? 0) + 1);
    p.brln.set(r.info.brln, (p.brln.get(r.info.brln) ?? 0) + 1);
    p.days.set(r.day, (p.days.get(r.day) ?? 0) + 1);
    p.ways.add(r.way);
    p.runs.push(r);
  }

  // 큰 패턴부터 자리를 잡고, 작은 패턴은 들어맞는 곳에 흡수시킵니다
  const list = [...pats.values()].sort((a, b) => b.stopSet.size - a.stopSet.size);
  const services = [];
  for (const p of list) {
    let hit = services.find(
      (s) => isSubset(p.stopSet, s.stopSet) && isSubset(p.skipSet, s.skipSet)
    );
    if (!hit) {
      hit = {
        stopSet: new Set(p.stopSet),
        skipSet: new Set(p.skipSet),
        trains: 0,
        edges: new Map(), // "A|B" → Map(소요초 → 몇 번)
        brln: new Map(),
        ends: new Map(),
        days: new Map(),
        ways: new Set(),
        runs: [],
      };
      services.push(hit);
    }
    hit.trains += p.n;
    for (const e of p.edges) {
      const k = `${e.a}|${e.b}`;
      const rk = `${e.b}|${e.a}`;
      const use = hit.edges.has(rk) ? rk : k; // 방향이 반대여도 같은 구간으로 셉니다
      if (!hit.edges.has(use)) hit.edges.set(use, new Map());
      const tally = hit.edges.get(use);
      tally.set(e.sec, (tally.get(e.sec) ?? 0) + 1);
    }
    for (const [k, v] of p.brln) hit.brln.set(k, (hit.brln.get(k) ?? 0) + v);
    for (const [k, v] of p.ends) hit.ends.set(k, (hit.ends.get(k) ?? 0) + v);
    for (const [k, v] of p.days) hit.days.set(k, (hit.days.get(k) ?? 0) + v);
    for (const w of p.ways) hit.ways.add(w);
    hit.runs.push(...p.runs);
  }
  return services;
}

// 갈래 이름 짓기.
//
//   화면에 보일 이름은 승강장 안내와 같은 말로 "급행" 또는 "특급"만 씁니다.
//   지어낸 이름(경인급행2 같은 것)은 쓰지 않습니다.
//
//   같은 구간(예: 동인천~용산)을 다니는 갈래가 둘이고 한쪽이 훨씬 많이 건너뛰면
//   그쪽을 "특급"이라 부릅니다 — 실제 경인선이 그렇습니다(급행 10역 통과 / 특급 15역 통과).
//   조금 차이나는 정도(경부선처럼 금천구청·의왕만 더 지나침)는 둘 다 "급행"입니다.
//
//   화면 이름은 겹쳐도 됩니다(경로 두 개가 다 "1호선 급행"인 건 사실이니까요).
//   대신 자료 안에서 구분하려고 `id`를 따로 둡니다.
const EXPRESS_GAP = 1.4; // 통과역이 이 배수 넘게 많으면 "특급"

function nameServices(services) {
  // 이 갈래가 다니는 구간의 양 끝 역 (운행의 첫 역·끝 역 중 가장 많이 나온 둘)
  for (const s of services) {
    const ends = [...s.ends].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k).sort();
    s.span = ends.join("~");
  }
  const groups = new Map();
  for (const s of services) {
    if (!groups.has(s.span)) groups.set(s.span, []);
    groups.get(s.span).push(s);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.skipSet.size - b.skipSet.size);
    const base = list[0].skipSet.size || 1;
    list.forEach((s, i) => {
      s.name = i > 0 && s.skipSet.size >= base * EXPRESS_GAP ? "특급" : "급행";
    });
  }
  // 자료 안에서 서로 구분할 이름(id)만 겹치지 않게 합니다
  const used = new Map();
  for (const s of services) {
    const n = (used.get(s.name) ?? 0) + 1;
    used.set(s.name, n);
    s.id = n > 1 ? `${s.name}${n}` : s.name;
  }
}

// ── 구간 소요시간 (완행 기준) ────────────────────────────────
//
// 시간표에는 "역과 역 사이 몇 분"이 없지만, **같은 열차**가 이웃한 두 역을
// 출발한 시각을 빼면 구할 수 있습니다. 열차마다 조금씩 다르므로 최빈값을 씁니다.
// ⚠️ 노선도상 실제 이웃이 아닌 쌍은 버립니다(급행이 건너뛴 구간이 섞이면 값이 망가집니다).
function addSectionTimes(rows, acc, nb) {
  const byTrain = new Map();
  for (const r of rows) {
    if (!r.no || !r.stn || !Number.isFinite(r.tOut)) continue;
    if (!byTrain.has(r.no)) byTrain.set(r.no, []);
    byTrain.get(r.no).push(r);
  }
  for (const stops of byTrain.values()) {
    stops.sort((a, b) => a.tOut - b.tOut);
    for (let i = 0; i + 1 < stops.length; i++) {
      const a = nn(stops[i].stn);
      const b = nn(stops[i + 1].stn);
      if (!isAdjacent(nb, a, b)) continue;
      // 초 단위로 계산합니다. 분으로 자르면 강남→역삼이 1분으로 나옵니다.
      const d = stops[i + 1].tOut - stops[i].tOut;
      if (d <= 0 || d > 15 * 60) continue;
      const k = `${a}|${b}`;
      if (!acc.has(k)) acc.set(k, new Map());
      const tally = acc.get(k);
      tally.set(d, (tally.get(d) ?? 0) + 1);
    }
  }
}

// 최빈값만 남겨 { "종로3가|을지로4가": 128 } 형태로 (단위: 초)
function pickModes(acc, minCount = 1) {
  const out = {};
  for (const [k, tally] of acc) {
    let best = 0;
    let max = 0;
    let total = 0;
    for (const [d, n] of tally) {
      total += n;
      if (n > max) {
        max = n;
        best = d;
      }
    }
    if (best && total >= minCount) out[k] = best;
  }
  return out;
}

// ── 본체 ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const report = args.includes("--report");
  const only = args.find((a) => !a.startsWith("--")) ?? null;
  const key = apiKey();
  const now = nowStamp();
  const targets = only ? TARGETS.filter((t) => t.line === only || t.api === only) : TARGETS;
  if (!targets.length) throw new Error(`'${only}' 는 이 API가 제공하지 않는 노선입니다`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const built = new Date().toISOString().slice(0, 10);
  const index = [];

  for (const { api, line, dirs } of targets) {
    console.log(`■ ${line}`);
    const nb = neighborsOf(line);
    if (!nb.size) console.log("   ⚠️ 노선도를 못 찾았습니다 — 급행 판별을 건너뜁니다");

    // 1) 원본 받기
    const packs = []; // { dir, way, day, rows }
    for (const [dir, way] of Object.entries(dirs)) {
      for (const [wknd, day] of Object.entries(DAYS)) {
        const rows = await collect(key, api, line, dir, wknd, now, console.log);
        packs.push({ dir, way, day, rows });
      }
    }

    // 2) 운행 단위로 쪼개 정차 패턴 분석
    //    (원본이 한 칸씩 밀려 온 운행은 여기서 바로잡습니다)
    const runs = [];
    let unknownEdges = 0;
    let repaired = 0;
    let dropped = 0;
    for (const p of packs) {
      p.usable = []; // 시간표·구간시간에 쓸 (바로잡은) 줄들
      for (const raw of runsOf(p.rows)) {
        const run = fixMisaligned(raw);
        if (!run) {
          dropped++;
          continue;
        }
        if (run !== raw) repaired++;
        const info = runInfo(run, nb);
        unknownEdges += info.unknown;
        runs.push({ way: p.way, day: p.day, run, info });
        p.usable.push(...run);
      }
    }
    if (repaired) console.log(`   ⚠️ 한 칸씩 밀려 있던 운행 ${repaired}건을 바로잡았습니다`);
    if (dropped) console.log(`   ⚠️ 모양이 이상해 버린 운행 ${dropped}건`);

    // 3) 급행 갈래 묶기
    //    잡음을 걸러냅니다.
    //      · 3대 미만은 우연일 수 있습니다.
    //      · **한 역만 건너뛰는 것은 급행이 아닙니다.** 노선도의 이름이 조금 어긋나거나
    //        종점 부근에서 한 역 덜 가는 열차가 그렇게 보입니다(수인분당선의 청량리 등).
    //        실제 급행은 최소 일곱 역 이상을 건너뜁니다.
    const kept = buildServices(runs).filter((s) => s.trains >= 3 && s.skipSet.size >= 2);
    nameServices(kept);
    // 각 운행에 "몇 번 갈래인지" 표시 (시간표 화면의 급행 표시에 씁니다)
    kept.forEach((s, i) => {
      for (const r of s.runs) for (const row of r.run) row.ex = i + 1;
    });

    const exRuns = runs.filter((r) => r.info.express).length;
    console.log(
      `   운행 ${runs.length}건 · 급행 운행 ${exRuns}건 · 급행 갈래 ${kept.length}가지` +
        (unknownEdges ? ` (노선도에서 못 찾은 구간 ${unknownEdges}건)` : "")
    );
    for (const s of kept) {
      console.log(
        `     · ${s.id} ${s.span}: ${s.trains}대 · 정차 ${s.stopSet.size}역 · 통과 ${s.skipSet.size}역 ` +
          `(평일 ${s.days.get("wd") ?? 0} / 주말 ${s.days.get("we") ?? 0})`
      );
      if (report) {
        console.log(`       정차: ${[...s.stopSet].join(" ")}`);
        console.log(`       통과: ${[...s.skipSet].join(" ")}`);
      }
    }

    if (report) {
      console.log("");
      continue; // --report 면 파일은 건드리지 않습니다
    }

    // 4) 역별 시간표 만들기
    // stations[역명][up|down][wd|we] = Set("분|행선지|급행갈래번호")
    const stations = new Map();
    const sectionAcc = new Map();
    const fromMain = new Set(); // 2호선에서 본선 자료가 이미 담긴 역
    for (const p of packs) {
      addSectionTimes(p.usable, sectionAcc, nb);
      for (const r of p.usable) {
        if (!r.stn || !r.dep || !Number.isFinite(r.min)) continue;
        // ⚠️ 통과역은 시간표에 넣지 않습니다 (서지도 않는데 시각이 뜨면 안 됩니다)
        if (!r.arr && nn(r.stn) !== nn(r.org)) continue;
        // 2호선: 본선(내선·외선)에 있는 역은 지선(상·하행)으로 덮어쓰지 않습니다.
        const isMain = MAIN_DIRS.has(p.dir);
        if (isMain) fromMain.add(r.stn);
        else if (fromMain.has(r.stn)) continue;

        if (!stations.has(r.stn)) stations.set(r.stn, { up: {}, down: {} });
        const slot = stations.get(r.stn)[p.way];
        if (!slot[p.day]) slot[p.day] = new Set();
        // ⚠️ 같은 열차가 'S' 접두 번호로 한 번 더 들어옵니다 (4301 / S4301).
        //    시각+행선지+급행종류로 묶어 중복을 없앱니다.
        slot[p.day].add(`${r.min}|${r.dest}|${r.ex ?? 0}`);
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
              const [min, dest, ex] = s.split("|");
              return Number(ex) ? [Number(min), idOf(dest), Number(ex)] : [Number(min), idOf(dest)];
            })
            .sort((a, b) => a[0] - b[0]);
          if (list.length) byDay[dayKey] = list;
        }
        if (Object.keys(byDay).length) o[way] = byDay;
      }
      if (Object.keys(o).length) outStations[stn] = o;
    }

    // 이 시간표가 언제부터 적용된 것인지도 적어둡니다
    const vbTally = new Map();
    for (const p of packs) for (const r of p.usable) vbTally.set(r.vb, (vbTally.get(r.vb) ?? 0) + 1);
    const validFrom = [...vbTally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

    const file = path.join(OUT_DIR, `${line}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        line,
        built,
        validFrom: validFrom ? validFrom.slice(0, 10) : "",
        dests,
        express: kept.map((s) => s.name), // 시간표 항목의 세 번째 숫자가 여기를 가리킵니다(1부터)
        stations: outStations,
      })
    );
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`  → ${line}.json  역 ${Object.keys(outStations).length}개 · ${kb}KB`);
    index.push({ line, stations: Object.keys(outStations).length, kb });

    // 5) 구간 소요시간 (노선 하나만 다시 받아도 나머지는 남기려고 병합)
    const prev = fs.existsSync(SEC_FILE)
      ? JSON.parse(fs.readFileSync(SEC_FILE, "utf8"))
      : { built, lines: {} };
    prev.built = built;
    prev.lines[line] = pickModes(sectionAcc);
    delete prev.express; // 급행은 express.json 으로 옮겼습니다
    fs.writeFileSync(SEC_FILE, JSON.stringify(prev));
    console.log(`  → section-times.json  ${line} 구간 ${Object.keys(prev.lines[line]).length}개`);

    // 6) 급행 파일
    const ex = fs.existsSync(EXPRESS_FILE)
      ? JSON.parse(fs.readFileSync(EXPRESS_FILE, "utf8"))
      : { built, lines: {} };
    ex.built = built;
    if (kept.length) {
      ex.lines[line] = kept.map((s) => ({
        id: s.id, // 자료 안에서 갈래를 구분하는 이름 (급행 / 특급 / 급행2 …)
        name: s.name, // 화면에 보일 이름 (급행 또는 특급)
        span: s.span, // 이 갈래가 다니는 구간
        trains: s.trains,
        wd: s.days.get("wd") ?? 0,
        we: s.days.get("we") ?? 0,
        ways: [...s.ways],
        stops: [...s.stopSet],
        skips: [...s.skipSet],
        // 급행이 실제로 달린 구간과 걸린 시간(초). 경로 계산은 이 값을 그대로 씁니다.
        edges: pickModes(s.edges, 2),
      }));
      console.log(`  → express.json  ${line} 급행 ${kept.length}갈래`);
    } else {
      delete ex.lines[line];
    }
    fs.writeFileSync(EXPRESS_FILE, JSON.stringify(ex, null, 1));
    console.log("");
  }

  if (!only && !report) {
    fs.writeFileSync(
      path.join(OUT_DIR, "index.json"),
      JSON.stringify({ built, lines: index }, null, 2)
    );
    const totalKb = index.reduce((s, x) => s + x.kb, 0);
    console.log(`완료: ${index.length}개 노선 · 합계 ${totalKb}KB`);
  }
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
