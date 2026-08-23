// 환승 정보 수집 스크립트 (자료가 갱신되면 다시 실행하면 됩니다)
//
// 무엇을 주는가:
//   환승역에서 "몇 호차 몇 번 문으로 내려서, 몇 분 걸어, 몇 호차 몇 번 문으로 타는지".
//   ODsay만 주는 줄 알았던 "빠른 환승 칸"과 "환승 소요시간"이 여기 다 들어 있습니다.
//
// 자료 두 가지를 받습니다. 둘 다 **인증키가 필요 없는 CSV** 입니다.
//
//   ① "서울교통공사_서울 도시철도 환승정보" (OA-22521) → src/lib/transfers.json
//      892건. 환승 시간 + 내리고 타는 호차·문까지 있습니다.
//      다만 **서울교통공사가 운영하는 구간만** 덮습니다.
//      (같은 자료가 공공데이터포털에도 있습니다: 15097652 API / 15098252 파일)
//
//   ② "서울교통공사_환승역거리 소요시간 정보" (OA-13290) → src/lib/transfer-times.json
//      140건. 호차·문은 없지만 **환승 거리(m)와 소요시간**이 있고,
//      ①에 없는 **코레일·민자 노선으로 갈아타는 경우**가 들어 있습니다
//      (서울역 1호선↔경의중앙선, 청량리 1호선↔경춘선, 신설동 1호선↔우이신설선 …).
//      소요시간은 "환승연결통로 최단거리 ÷ 보행속도 1.2m/s" 로 계산된 값입니다.
//      ⚠️ 내려받기 폼 값이 자료마다 다릅니다(이건 seqNo=8&seq=8&infSeq=1).
//         데이터셋 페이지 HTML의 `downloadFile('8')` 안 숫자가 seqNo 입니다.
//
// ⚠️ 내려받기가 POST입니다. 페이지의 downloadFile()이 폼을 POST로 보내는 구조라
//    주소만 GET으로 부르면 400이 납니다.
//
// 실행: (poogsin 폴더에서)  node scripts/build-transfers.mjs

import fs from "node:fs";
import path from "node:path";

const URL_ = "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false";
const FORM = "infId=OA-22521&seqNo=&seq=1&infSeq=2";
const OUT = path.join(process.cwd(), "src", "lib", "transfers.json");
const FORM_DIST = "infId=OA-13290&seqNo=8&seq=8&infSeq=1";
const OUT_DIST = path.join(process.cwd(), "src", "lib", "transfer-times.json");

// 자료의 호선 표기 → 앱에서 쓰는 이름
const LINE_NAME = {
  "1": "1호선", "2": "2호선", "3": "3호선", "4": "4호선", "5": "5호선",
  "6": "6호선", "7": "7호선", "8": "8호선", "9": "9호선",
  공항철도: "공항철도", 경의중앙선: "경의중앙선", 수인분당선: "수인분당선",
  신분당선: "신분당선", 경춘선: "경춘선", 서해선: "서해선", 경강선: "경강선",
  우이신설선: "우이신설선", 신림선: "신림선", 인천1호선: "인천1호선", 인천2호선: "인천2호선",
  김포골드라인: "김포골드라인", 의정부경전철: "의정부경전철", 용인경전철: "용인경전철",
  "GTX-A": "GTX-A",
};
// 노선도(linemap)는 또 다르게 적습니다 — 여기서 같이 맞춰줍니다.
// (안 맞추면 "서울 1호선↔경의중앙선" 같은 행이 통째로 버려집니다)
const LINEMAP_NAME = {
  "경의·중앙선": "경의중앙선",
  우이신설경전철: "우이신설선",
  서해: "서해선",
  신림: "신림선",
};
const lineOf = (raw) => {
  const s = String(raw).trim();
  return LINE_NAME[s] ?? LINEMAP_NAME[s] ?? s;
};

// 역 이름 정규화 (src/lib/timetable.ts 와 같은 규칙)
const ALIAS = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s) =>
  String(s || "").replace(/\s/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();
const nn = (s) => ALIAS[bare(s)] ?? bare(s);

// "10:00" → 600초, "03:34" → 214초
function toSec(mmss) {
  const [m, s] = String(mmss).split(":").map(Number);
  if (!Number.isFinite(m)) return null;
  return m * 60 + (s || 0);
}

// 따옴표를 고려한 CSV 한 줄 파싱
function splitCsv(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// 서울열린데이터광장 파일 내려받기 (POST 여야 합니다 — GET 이면 400)
async function download(form, infId) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      Referer: `https://data.seoul.go.kr/dataList/${infId}/F/1/datasetView.do`,
    },
    body: form,
  });
  if (!res.ok) throw new Error(`내려받기 실패 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 이 파일들은 EUC-KR 입니다.
  let text = new TextDecoder("euc-kr").decode(buf);
  if (!/[가-힣]/.test(text)) text = buf.toString("utf8");
  if (/<html/i.test(text))
    throw new Error(`${infId}: 파일 대신 안내 문구가 왔습니다 — 폼 값(seqNo·seq·infSeq)을 확인하세요`);
  return text;
}

// 노선도에서 "이 역에 어떤 노선이 지나는지" (자료의 노선 이름을 검증하는 데 씁니다)
function linesAtStation() {
  const linemap = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "src", "lib", "linemap.json"), "utf8")
  );
  const at = new Map();
  for (const l of linemap) {
    const nameAt = new Map();
    for (const n of l.nodes) if (n.name) nameAt.set(`${n.x},${n.y}`, n.name);
    for (const n of l.nodes) {
      const name = n.name ?? nameAt.get(`${n.x},${n.y}`);
      if (!name) continue;
      const k = nn(name);
      if (!at.has(k)) at.set(k, new Set());
      at.get(k).add(lineOf(l.label));
    }
  }
  return at;
}

// ② 환승역거리·소요시간 (OA-13290)
//
// ⚠️ 이 자료의 노선 이름에는 옛 표기가 섞여 있습니다 — "국철"·"경원선" 처럼.
//    그래서 **그 역에 실제로 지나는 노선인지 노선도로 확인**하고, 못 고르면 버립니다(추측 금지).
async function buildDistances() {
  console.log("환승 거리·소요시간(OA-13290) 내려받는 중…");
  const text = await download(FORM_DIST, "OA-13290");
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(1)
    .map(splitCsv);
  const at = linesAtStation();
  // 옛 이름 → 지금 이름 후보 (여러 개면 그 역에 실제로 있는 노선으로 좁힙니다)
  const OLD = { 국철: ["수인분당선", "경의중앙선", "1호선", "경춘선"], 경원선: ["1호선"] };
  const out = {};
  let used = 0;
  const dropped = [];
  for (const r of rows) {
    // 연번,호선,환승역명,환승노선,환승거리,환승소요시간
    const [, ln, stn, to, dist, time] = r;
    const sec = toSec(time);
    if (!stn || !sec) continue;
    const s = nn(stn);
    const here = at.get(s) ?? new Set();
    const a = lineOf(/^\d+$/.test(String(ln).trim()) ? `${String(ln).trim()}호선` : ln);
    let b = lineOf(to);
    if (!here.has(b)) {
      const cand = (OLD[String(to).trim()] ?? []).filter((c) => here.has(c) && c !== a);
      if (cand.length === 1) b = cand[0];
    }
    if (a === b || !here.has(a) || !here.has(b)) {
      dropped.push(`${s} ${a}→${to}`);
      continue;
    }
    // 걸어가는 거리는 양쪽이 같으므로 두 방향 모두 넣습니다
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      out[s] ??= {};
      out[s][x] ??= {};
      if (out[s][x][y] == null) out[s][x][y] = { sec, m: Number(dist) || null };
    }
    used++;
  }
  fs.writeFileSync(
    OUT_DIST,
    JSON.stringify({ built: new Date().toISOString().slice(0, 10), source: "OA-13290", stations: out })
  );
  let pairs = 0;
  for (const byLine of Object.values(out))
    for (const byTo of Object.values(byLine)) pairs += Object.keys(byTo).length;
  console.log(
    `→ transfer-times.json  ${used}건 → 환승역 ${Object.keys(out).length}개 · 노선쌍 ${pairs}개`
  );
  if (dropped.length)
    console.log(
      `   (노선도에서 확인이 안 돼 버린 행 ${dropped.length}개: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? " …" : ""})`
    );
}

async function main() {
  console.log("환승정보(OA-22521) 내려받는 중…");
  const text = await download(FORM, "OA-22521");

  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = lines.slice(1).map(splitCsv);
  console.log(`  ${rows.length}건`);

  // 역 → 출발노선 → 도착노선 → [환승 경우들]
  const out = {};
  let skipped = 0;
  for (const r of rows) {
    // 고유번호,환승시작역,코드,시작호선,하차방면,하차호차,하차문,종료역,코드,종료호선,환승방면,승차호차,승차문,소요시간
    const [, stn, , fromL, fromWay, offCar, offDoor, , , toL, toWay, onCar, onDoor, dur] = r;
    const sec = toSec(dur);
    if (!stn || !sec) { skipped++; continue; }
    const s = nn(stn);
    const a = lineOf(fromL);
    const b = lineOf(toL);
    if (a === b) { skipped++; continue; }
    out[s] ??= {};
    out[s][a] ??= {};
    out[s][a][b] ??= [];
    out[s][a][b].push({
      fromWay: String(fromWay || "").replace(/\s*방면$/, ""),
      toWay: String(toWay || "").replace(/\s*방면$/, ""),
      off: `${offCar}-${offDoor}`, // 내리는 위치: 호차-문
      on: `${onCar}-${onDoor}`, // 타는 위치
      sec,
    });
  }

  const stations = Object.keys(out).length;
  let pairs = 0;
  for (const byLine of Object.values(out))
    for (const byTo of Object.values(byLine)) pairs += Object.keys(byTo).length;

  fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString().slice(0, 10), stations: out }));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`→ transfers.json  환승역 ${stations}개 · 노선쌍 ${pairs}개 · ${kb}KB (건너뜀 ${skipped})`);

  await buildDistances();
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
