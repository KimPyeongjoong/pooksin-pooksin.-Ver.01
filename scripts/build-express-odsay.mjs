// 코레일 급행 정차 패턴 수집 (ODsay) — 호출 몇 번이면 끝납니다.
//
// 왜 필요한가:
//   1호선 경인·경부급행, 수인분당 급행, 경의중앙 급행, 공항철도 직통은
//   **코레일·민자가 운영**해서 서울교통공사·서울시 API 어디에도 없습니다.
//   확인한 근거:
//     - 15143847: 급행 정차역(부천)과 미정차역(소사)의 출발 횟수가 857회로 동일 = 완행만 있음
//     - 서울시 EXPRESS_YN: 9호선에서만 급행을 뜻함. 1호선의 D 열차 104대는 온수·소사에도 전부 정차
//
//   ODsay는 이걸 "1호선(급행)"처럼 **별도 노선 이름**으로 알고 있고,
//   경로 응답의 passStopList 에 그 급행이 서는 역이 순서대로 들어 있습니다.
//   그래서 급행 구간의 양 끝 역만 검색하면 정차 패턴을 통째로 얻습니다.
//
// 실행: (poogsin 폴더에서)  node scripts/build-express-odsay.mjs
//   ⚠️ ODsay 한도는 자정에 초기화됩니다.

import fs from "node:fs";
import path from "node:path";
import linemap from "../src/lib/linemap.json" with { type: "json" };
import coords from "../src/lib/station-coords.json" with { type: "json" };

const ODSAY = "https://api.odsay.com/v1/api/searchPubTransPathT";
const SEC_FILE = path.join(process.cwd(), "src", "lib", "section-times.json");

// 급행이 다니는 구간의 양 끝. 이 사이를 검색하면 ODsay가 급행 경로를 줍니다.
const CORRIDORS = [
  { line: "1호선", from: "구로", to: "동인천" }, // 경인급행·특급
  { line: "1호선", from: "서울역", to: "천안" }, // 경부급행
  { line: "수인분당선", from: "왕십리", to: "수원" },
  { line: "수인분당선", from: "인천", to: "오이도" },
  { line: "경의중앙선", from: "용문", to: "문산" },
  { line: "공항철도", from: "서울역", to: "인천공항1터미널" },
  { line: "경춘선", from: "청량리", to: "춘천" }, // ITX 계열
  { line: "서해선", from: "일산", to: "원시" },
];

const ALIAS = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s) =>
  String(s || "").replace(/\s/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();
const nn = (s) => ALIAS[bare(s)] ?? bare(s);
const LINEMAP_NAME = { 신림선: "신림", 서해선: "서해", 우이신설선: "우이신설경전철", 경의중앙선: "경의·중앙선" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ODsay 노선명 → 앱 이름 + 급행 여부
function parseLane(name) {
  const raw = String(name || "");
  const express = /급행|특급|직통/.test(raw);
  const base = raw
    .replace(/^수도권\s*/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  const M = {
    경의선: "경의중앙선", 중앙선: "경의중앙선", 경의중앙선: "경의중앙선",
    인천선: "인천1호선", 분당선: "수인분당선", 수인분당: "수인분당선",
    신분당: "신분당선", 서해: "서해선", 신림: "신림선",
  };
  return { line: M[base] ?? base, express };
}

function lineInfo(line) {
  const label = LINEMAP_NAME[line] ?? line;
  const l = linemap.find((x) => nn(x.label) === nn(label));
  if (!l) return { adj: new Set() };
  const nameAt = new Map();
  for (const n of l.nodes) if (n.name) nameAt.set(`${n.x},${n.y}`, n.name);
  const adj = new Set();
  let prev = null;
  for (const n of l.nodes) {
    if (n.m) prev = null;
    const nm = n.name ?? nameAt.get(`${n.x},${n.y}`);
    if (!nm) continue;
    const k = nn(nm);
    if (prev && prev !== k) { adj.add(`${prev}|${k}`); adj.add(`${k}|${prev}`); }
    prev = k;
  }
  return { adj };
}

function apiKey() {
  const env = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(/ODSAY_API_KEY=(.*)/);
  if (!m) throw new Error(".env.local 에 ODSAY_API_KEY 가 없습니다");
  return m[1].trim();
}

async function main() {
  const key = apiKey();
  const sec = JSON.parse(fs.readFileSync(SEC_FILE, "utf8"));
  sec.express ??= {};
  let calls = 0, found = 0;

  for (const c of CORRIDORS) {
    const A = coords[c.from], B = coords[c.to];
    if (!A || !B) { console.log(`■ ${c.line} ${c.from}→${c.to}: 좌표 없음`); continue; }
    calls++;
    let data;
    try {
      const r = await fetch(
        `${ODSAY}?apiKey=${encodeURIComponent(key)}&SX=${A.x}&SY=${A.y}&EX=${B.x}&EY=${B.y}&SearchPathType=1`
      );
      data = await r.json();
    } catch {
      console.log(`■ ${c.line} ${c.from}→${c.to}: 연결 실패`);
      continue;
    }
    const err = Array.isArray(data?.error) ? data.error[0] : data?.error;
    if (err) {
      const msg = String(err.message ?? "");
      if (/quota|429/i.test(msg) || String(err.code) === "429") {
        console.log("한도 소진 — 여기까지 저장하고 멈춥니다.");
        break;
      }
      console.log(`■ ${c.line} ${c.from}→${c.to}: ${msg || err.code}`);
      await sleep(500);
      continue;
    }

    const { adj } = lineInfo(c.line);
    let added = 0;
    // ⚠️ 급행을 못 찾을 때 원인을 알 수 있게, 응답에 들어온 노선 이름을 모아둡니다.
    //    (ODsay가 급행을 "1호선(급행)"이 아니라 다른 이름으로 줄 수도 있습니다)
    const seenLanes = new Set();
    for (const p of data?.result?.path ?? []) {
      for (const sp of p.subPath ?? []) {
        if (sp.trafficType !== 1) continue;
        const rawName = sp.lane?.[0]?.name;
        seenLanes.add(String(rawName ?? "?"));
        const lane = parseLane(rawName);
        if (!lane.express || lane.line !== c.line) continue;
        const stops = (sp.passStopList?.stations ?? []).map((x) => nn(x.stationName));
        // 급행 정차역을 순서대로 이으면서, 이웃이 아닌 구간만 저장합니다.
        // 시간은 구간 평균으로 나눠 넣습니다(ODsay는 구간별 시간을 따로 주지 않습니다).
        const perHop = Math.max(60, Math.round(((sp.sectionTime || 1) * 60) / Math.max(1, stops.length - 1)));
        for (let i = 0; i + 1 < stops.length; i++) {
          const k = `${stops[i]}|${stops[i + 1]}`;
          if (adj.has(k)) continue;
          sec.express[c.line] ??= {};
          if (sec.express[c.line][k] == null) { sec.express[c.line][k] = perHop; added++; }
        }
      }
    }
    found += added;
    console.log(
      `■ ${c.line} ${c.from}→${c.to}: 건너뛰는 구간 ${added}개` +
        (added ? "" : `  ← 응답에 온 노선 이름: [${[...seenLanes].join(", ")}]`)
    );
    fs.writeFileSync(SEC_FILE, JSON.stringify(sec));
    await sleep(600);
  }

  console.log(`\nODsay 호출 ${calls}건 · 새로 채운 급행 구간 ${found}개`);
  console.log(`급행 노선: ${Object.keys(sec.express).join(", ")}`);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
