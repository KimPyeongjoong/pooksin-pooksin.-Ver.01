// 급행 열차 수집 (서울열린데이터광장)
//
// 왜 따로 만드나:
//   경로 계산이 늘 완행 기준이면 실제보다 한참 느리게 나옵니다.
//   그런데 서울교통공사 열차시간표(15143847)에는 **코레일 급행이 빠져 있습니다**.
//   실측: 1호선 경인선에서 급행이 서는 부천과 안 서는 소사의 출발 횟수가 857회로 똑같았습니다.
//   = 그 자료에는 완행만 있다는 뜻입니다.
//
//   서울열린데이터광장의 역별 시간표에는 `EXPRESS_YN` 항목이 있고,
//   **`D`가 급행, `G`가 일반**입니다. 부천에서 급행 105대가 잡힙니다.
//
// 출처: 서울열린데이터광장 SearchSTNTimeTableByIDService
//   http://openapi.seoul.go.kr:8088/{키}/json/SearchSTNTimeTableByIDService/1/1000/{역코드}/{요일}/{상하행}/
//   요일 1=평일 2=토 3=일·공휴일 · 상하행 1=상행 2=하행
//   키: .env.local 의 SEOUL_OPEN_API_KEY
//
// 어떻게 만드나:
//   그 노선의 모든 역을 훑어 `EXPRESS_YN=D` 인 기록만 모읍니다.
//   같은 열차번호(TRAIN_NO)끼리 묶으면 그 급행이 어디어디 서는지 순서가 나옵니다.
//   이웃하지 않은 두 정차역 사이가 곧 "건너뛴 구간"이고, 그 시간차가 급행 소요시간입니다.
//
// 실행: (poogsin 폴더에서)  node scripts/build-express.mjs
//   결과는 src/lib/section-times.json 의 express 항목에 합쳐집니다.

import fs from "node:fs";
import path from "node:path";
import linemap from "../src/lib/linemap.json" with { type: "json" };

const SEOUL = "http://openapi.seoul.go.kr:8088";
const METRO = "https://apis.data.go.kr/B553766/schedule/getTrainSch";
const SEC_FILE = path.join(process.cwd(), "src", "lib", "section-times.json");

// 급행이 다니는 노선만 (완행뿐인 노선은 부를 필요가 없습니다)
const TARGETS = [
  { line: "1호선", api: "1호선" },
  { line: "9호선", api: "9호선" },
  { line: "수인분당선", api: "수인분당선" },
  { line: "경의중앙선", api: "경의선" },
  { line: "공항철도", api: "공항철도" },
  { line: "경춘선", api: "경춘선" },
  { line: "서해선", api: "서해선" },
];

const ALIAS = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s) =>
  String(s || "").replace(/\s/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();
const nn = (s) => ALIAS[bare(s)] ?? bare(s);
const LINEMAP_NAME = { 신림선: "신림", 서해선: "서해", 우이신설선: "우이신설경전철", 경의중앙선: "경의·중앙선" };
const tag = (blk, k) => (blk.match(new RegExp(`<${k}>([^<]*)</${k}>`)) || [])[1] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keys() {
  const env = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  return {
    metro: (env.match(/SEOUL_METRO_API_KEY=(.*)/) || [])[1]?.trim(),
    seoul: (env.match(/SEOUL_OPEN_API_KEY=(.*)/) || [])[1]?.trim(),
  };
}

// 노선의 역 순서 + 이웃 관계 (노선도 기준)
function lineInfo(line) {
  const label = LINEMAP_NAME[line] ?? line;
  const l = linemap.find((x) => nn(x.label) === nn(label));
  if (!l) return { order: [], adj: new Set() };
  const nameAt = new Map();
  for (const n of l.nodes) if (n.name) nameAt.set(`${n.x},${n.y}`, n.name);
  const order = [];
  const seen = new Set();
  const adj = new Set();
  let prev = null;
  for (const n of l.nodes) {
    if (n.m) prev = null;
    const nm = n.name ?? nameAt.get(`${n.x},${n.y}`);
    if (!nm) continue;
    const k = nn(nm);
    if (!seen.has(k)) { seen.add(k); order.push(k); }
    if (prev && prev !== k) { adj.add(`${prev}|${k}`); adj.add(`${k}|${prev}`); }
    prev = k;
  }
  return { order, adj };
}

// 역 이름 → 역코드 (서울시 API가 코드를 요구합니다)
async function stationCodes(metroKey, api, want) {
  const map = new Map();
  for (let page = 1; page <= 20 && map.size < want.size; page++) {
    const qs = new URLSearchParams({
      numOfRows: "5000", pageNo: String(page), tmprTmtblYn: "N",
      upbdnbSe: "상행", wkndSe: "평일", lineNm: api,
    });
    const r = await fetch(`${METRO}?serviceKey=${metroKey}&${qs}`);
    const t = await r.text();
    let rows = 0;
    for (const m of t.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      rows++;
      if (tag(m[1], "lineNm") !== api) continue;
      const nm = nn(tag(m[1], "stnNm"));
      const cd = tag(m[1], "stnCd");
      if (nm && cd && !map.has(nm)) map.set(nm, cd);
    }
    if (rows < 5000) break;
  }
  return map;
}

async function main() {
  const { metro, seoul } = keys();
  if (!metro || !seoul) throw new Error(".env.local 에 키가 필요합니다");

  const sec = JSON.parse(fs.readFileSync(SEC_FILE, "utf8"));
  sec.express ??= {};
  let calls = 0;

  for (const { line, api } of TARGETS) {
    const { order, adj } = lineInfo(line);
    if (!order.length) { console.log(`■ ${line}: 노선도 없음`); continue; }
    const codes = await stationCodes(metro, api, new Set(order));
    console.log(`■ ${line} — 역 ${order.length}개 중 코드 확보 ${codes.size}개`);

    // 급행 열차번호 → 정차 기록
    const trains = new Map();
    for (const stn of order) {
      const cd = codes.get(stn);
      if (!cd) continue;
      for (const updn of ["1", "2"]) {
        calls++;
        try {
          const r = await fetch(`${SEOUL}/${seoul}/json/SearchSTNTimeTableByIDService/1/1000/${cd}/1/${updn}/`);
          const j = await r.json();
          for (const row of j?.SearchSTNTimeTableByIDService?.row ?? []) {
            if (row.EXPRESS_YN !== "D") continue; // D = 급행
            const t = String(row.LEFTTIME || row.ARRIVETIME || "");
            const [h, m, s] = t.split(":").map(Number);
            if (!Number.isFinite(h)) continue;
            const key = `${row.TRAIN_NO}|${updn}`;
            if (!trains.has(key)) trains.set(key, []);
            trains.get(key).push({ stn, sec: h * 3600 + (m || 0) * 60 + (s || 0) });
          }
        } catch {
          /* 한 역 실패는 넘어갑니다 */
        }
        await sleep(60);
      }
    }

    // 같은 열차의 정차역을 순서대로 이어 "건너뛴 구간"을 찾습니다
    const acc = new Map();
    for (const stops of trains.values()) {
      const seenStn = new Map();
      for (const s of stops) if (!seenStn.has(s.stn) || s.sec < seenStn.get(s.stn)) seenStn.set(s.stn, s.sec);
      const seq = [...seenStn.entries()]
        .map(([stn, sc]) => ({ stn, sec: sc, i: order.indexOf(stn) }))
        .filter((x) => x.i >= 0)
        .sort((a, b) => a.i - b.i);
      for (let i = 0; i + 1 < seq.length; i++) {
        const a = seq[i], b = seq[i + 1];
        const d = Math.abs(b.sec - a.sec);
        if (d <= 0 || d > 20 * 60) continue;
        const k = `${a.stn}|${b.stn}`;
        if (adj.has(k)) continue; // 이웃끼리면 건너뛴 게 아님
        if (!acc.has(k)) acc.set(k, new Map());
        acc.get(k).set(d, (acc.get(k).get(d) ?? 0) + 1);
      }
    }

    const out = {};
    for (const [k, tally] of acc) {
      let best = 0, max = 0, total = 0;
      for (const [d, n] of tally) { total += n; if (n > max) { max = n; best = d; } }
      if (total >= 5 && best) out[k] = best; // 여러 열차에서 반복돼야 진짜 패턴
    }
    if (Object.keys(out).length) {
      sec.express[line] = { ...(sec.express[line] ?? {}), ...out };
      console.log(`   급행 열차 ${trains.size}대 → 건너뛰는 구간 ${Object.keys(out).length}개`);
    } else {
      console.log(`   급행 없음 (열차 ${trains.size}대)`);
    }
    fs.writeFileSync(SEC_FILE, JSON.stringify(sec));
  }

  console.log(`\n서울시 API 호출 ${calls}건 · 급행 노선 ${Object.keys(sec.express).length}개`);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
