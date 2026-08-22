// 환승 시간 보충 수집 (ODsay) — 하루 한도를 다 쓰지 않도록 딱 필요한 만큼만 부릅니다.
//
// 왜 필요한가:
//   서울교통공사 환승정보(transfers.json)는 **자기가 운영하는 86개 역만** 덮습니다.
//   경의중앙·서해·GTX-A·공항철도 같은 코레일·민자 노선 환승은 자료가 없어서
//   경로 계산이 전부 "3분"이라는 상수를 쓰고 있었습니다(실제는 1~22분).
//   그 빈칸만 ODsay 경로검색으로 재서 파일에 넣어둡니다. 한 번 받으면 끝입니다.
//
// 어떻게 재는가:
//   환승역 S에서 A노선 → B노선 환승 시간을 알고 싶으면,
//   A노선에서 S 두 정거장 앞 역 P, B노선에서 S 두 정거장 뒤 역 Q를 잡아
//   P → Q 경로를 검색합니다. 그 경로 안에 "A노선으로 S 도착 → 도보 → B노선으로 S 출발"이
//   들어 있으면, 그 도보 구간의 시간이 곧 환승 시간입니다.
//   경로가 S를 안 지나가면 버립니다.
//
// 안전장치:
//   - 이미 채운 조합은 건너뜁니다. 중간에 멈춰도 다시 실행하면 이어서 합니다.
//   - 한 번에 하나씩만 부릅니다(ODsay는 동시 호출이 몰리면 연결을 끊습니다).
//   - 한도(무료 1,000건)를 넘지 않게 상한을 둡니다.
//
// 실행: (poogsin 폴더에서)  node scripts/build-transfers-odsay.mjs
//   ⚠️ ODsay 한도는 자정에 초기화됩니다. 낮에 이미 썼다면 자정 이후에 돌리세요.

import fs from "node:fs";
import path from "node:path";
import linemap from "../src/lib/linemap.json" with { type: "json" };
import coords from "../src/lib/station-coords.json" with { type: "json" };
import official from "../src/lib/transfers.json" with { type: "json" };

const ODSAY = "https://api.odsay.com/v1/api/searchPubTransPathT";
const OUT = path.join(process.cwd(), "src", "lib", "transfers-extra.json");
const MAX_CALLS = 800; // 하루 한도(1,000) 안쪽으로
const GAP_MS = 400; // 호출 간격

// ── 이름 정규화 (다른 파일들과 같은 규칙) ─────────────────────
const ALIAS = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s) =>
  String(s || "").replace(/\s/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();
const nn = (s) => ALIAS[bare(s)] ?? bare(s);

// 노선도 라벨 → 앱에서 쓰는 이름
const SHORT = { "경의·중앙선": "경의중앙선", 우이신설경전철: "우이신설선", 서해: "서해선", 신림: "신림선" };
const short = (s) => SHORT[s] ?? s;
// ODsay가 주는 노선명 → 앱 이름
const ODSAY_ALIAS = {
  "경의중앙선": "경의중앙선", "경의선": "경의중앙선", "중앙선": "경의중앙선",
  "인천선": "인천1호선", "인천1호선": "인천1호선", "인천2호선": "인천2호선",
  "김포도시철도": "김포골드라인", "김포골드라인": "김포골드라인",
  "우이신설경전철": "우이신설선", "우이신설선": "우이신설선",
  "서해": "서해선", "서해선": "서해선", "신림": "신림선", "신림선": "신림선",
  "수인분당": "수인분당선", "신분당": "신분당선", "분당선": "수인분당선",
};
const odsayLine = (name) => {
  const s = String(name || "")
    .replace(/^수도권\s*/, "")
    .replace(/^인천\s*(\d)/, "인천$1")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  return ODSAY_ALIAS[s] ?? s;
};

// ── 노선별 역 순서 · 역별 노선 ────────────────────────────────
const order = {};
const linesAt = new Map();
for (const l of linemap) {
  const label = short(l.label);
  const nameAt = new Map();
  for (const n of l.nodes) if (n.name) nameAt.set(`${n.x},${n.y}`, n.name);
  const seq = [];
  const seen = new Set();
  for (const n of l.nodes) {
    const nm = n.name ?? nameAt.get(`${n.x},${n.y}`);
    if (!nm) continue;
    const k = nn(nm);
    if (!seen.has(k)) { seen.add(k); seq.push(k); }
    if (!linesAt.has(k)) linesAt.set(k, new Set());
    linesAt.get(k).add(label);
  }
  order[label] = seq;
}

// 원래 이름(좌표 조회용)
const DISPLAY = new Map();
for (const l of linemap) for (const n of l.nodes) if (n.name && !DISPLAY.has(nn(n.name))) DISPLAY.set(nn(n.name), n.name.replace(/\s+/g, ""));
const COORD = (k) => coords[DISPLAY.get(k) ?? k] ?? coords[k];

// S에서 line을 따라 두어 정거장 떨어진 역 (탐색용 출발/도착점)
function nearby(line, s) {
  const o = order[line] ?? [];
  const i = o.indexOf(s);
  if (i < 0) return null;
  for (const d of [2, -2, 3, -3, 1, -1]) {
    const j = i + d;
    if (j >= 0 && j < o.length && o[j] !== s && COORD(o[j])) return o[j];
  }
  return null;
}

function apiKey() {
  const env = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(/ODSAY_API_KEY=(.*)/);
  if (!m) throw new Error(".env.local 에 ODSAY_API_KEY 가 없습니다");
  return m[1].trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = apiKey();
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { built: "", stations: {} };
  out.stations ??= {};

  // 채워야 할 조합 모으기
  const todo = [];
  for (const [stn, set] of linesAt) {
    const ls = [...set];
    if (ls.length < 2) continue;
    for (const a of ls)
      for (const b of ls) {
        if (a === b) continue;
        if (official.stations?.[stn]?.[a]?.[b]) continue; // 공식 자료가 있으면 건너뜀
        if (out.stations?.[stn]?.[a]?.[b] != null) continue; // 이미 받아둔 것도 건너뜀
        const p = nearby(a, stn);
        const q = nearby(b, stn);
        if (!p || !q || p === q) continue;
        todo.push({ stn, a, b, p, q });
      }
  }
  console.log(`채울 조합 ${todo.length}개 (공식 자료 있는 것과 이미 받은 것은 제외)`);
  if (!todo.length) return;

  let calls = 0, ok = 0, skip = 0;
  for (const t of todo) {
    if (calls >= MAX_CALLS) { console.log("상한에 도달해 멈춥니다. 내일 다시 실행하면 이어서 합니다."); break; }
    const P = COORD(t.p), Q = COORD(t.q);
    if (!P || !Q) { skip++; continue; }
    const url =
      `${ODSAY}?apiKey=${encodeURIComponent(key)}` +
      `&SX=${P.x}&SY=${P.y}&EX=${Q.x}&EY=${Q.y}&SearchPathType=1`;
    calls++;
    let data;
    try {
      const r = await fetch(url);
      data = await r.json();
    } catch {
      console.log(`  ! ${t.stn} ${t.a}→${t.b} 연결 실패`);
      await sleep(GAP_MS * 3);
      continue;
    }
    const err = Array.isArray(data?.error) ? data.error[0] : data?.error;
    if (err) {
      const msg = String(err.message ?? "");
      if (/quota|429|초과/i.test(msg) || String(err.code) === "429") {
        console.log(`한도 소진 — ${ok}건 저장하고 멈춥니다. 자정 이후 다시 실행하세요.`);
        break;
      }
      skip++;
      await sleep(GAP_MS);
      continue;
    }

    // 경로 안에서 "A노선으로 S 도착 → 도보 → B노선으로 S 출발"을 찾습니다
    let found = null;
    for (const path_ of data?.result?.path ?? []) {
      const sp = path_.subPath ?? [];
      for (let i = 0; i + 2 < sp.length; i++) {
        const x = sp[i], w = sp[i + 1], y = sp[i + 2];
        if (x.trafficType !== 1 || w.trafficType !== 3 || y.trafficType !== 1) continue;
        if (nn(x.endName) !== t.stn || nn(y.startName) !== t.stn) continue;
        if (odsayLine(x.lane?.[0]?.name) !== t.a) continue;
        if (odsayLine(y.lane?.[0]?.name) !== t.b) continue;
        found = Math.max(60, Math.round((w.sectionTime || 1) * 60));
        break;
      }
      if (found) break;
    }
    if (found) {
      out.stations[t.stn] ??= {};
      out.stations[t.stn][t.a] ??= {};
      out.stations[t.stn][t.a][t.b] = found;
      ok++;
      console.log(`  ${t.stn} ${t.a}→${t.b} : ${Math.round(found / 60)}분`);
    } else {
      skip++;
    }
    // 중간에 멈춰도 잃지 않도록 자주 저장합니다
    if (ok % 10 === 0) {
      out.built = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(OUT, JSON.stringify(out));
    }
    await sleep(GAP_MS);
  }

  out.built = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(OUT, JSON.stringify(out));
  const total = Object.values(out.stations).reduce(
    (n, byA) => n + Object.values(byA).reduce((m, byB) => m + Object.keys(byB).length, 0), 0);
  console.log(`\n호출 ${calls}건 · 새로 채움 ${ok}건 · 못 구함 ${skip}건 · 누적 ${total}건 → transfers-extra.json`);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
