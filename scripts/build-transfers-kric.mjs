// 코레일·민자 노선 환승 거리 수집 (레일포털 KRIC)
//
// 왜 필요한가:
//   환승 시간은 지금 두 자료로 채웁니다(scripts/build-transfers.mjs 참고).
//     ① 서울교통공사 환승정보(OA-22521)  ② 서울교통공사 환승역거리(OA-13290)
//   둘 다 **서울교통공사 자료**라, 양쪽 다 서울교통공사가 아닌 환승은 비어 있습니다.
//   회기(1호선↔경춘↔경의중앙) · 용산 · 부평(1호선↔인천1) · 김포공항 · 판교 · GTX 환승 등
//   **116개 조합이 아직 3분 상수**입니다.
//
//   레일포털(KRIC)의 "역사별 환승정보"는 **전국 철도운영기관**을 덮습니다.
//   응답에 환승거리(chtnDst)가 있고, 소요시간은 서울교통공사 공식 산출법으로 환산합니다.
//     환승 소요시간 = 환승거리 ÷ 1.2m/s  (OA-13290 자료에 적힌 그 기준)
//
// 출처(레일포털 https://data.kric.go.kr):
//   역사별 정보     https://openapi.kric.go.kr/openapi/convenientInfo/stationInfo
//   역사별 환승정보 https://openapi.kric.go.kr/openapi/convenientInfo/stationTransferInfo
//
// ⚠️ **레일포털은 공공데이터포털과 별개입니다.** 따로 회원가입하고 위 두 API를 활용신청해야 합니다.
//    키 없이 부르면 이렇게 옵니다: {"header":{"resultCode":"30","resultMsg":"등록되지 않은 서비스키입니다."}}
//    받은 키는 .env.local 에 `KRIC_API_KEY=...` 로 넣어주세요.
//
// 실행: (poogsin 폴더에서)
//   node scripts/build-transfers-kric.mjs           빈칸인 환승역을 훑어서 파일로 저장
//   node scripts/build-transfers-kric.mjs --probe 회기   한 역만 불러서 원본 응답 그대로 보기
//
// 결과: src/lib/transfer-times-kric.json
//   경로검색은 ①환승정보 → ②환승역거리 → ③이 파일 → ④예전 보충값 → ⑤3분 상수 순으로 씁니다.

import fs from "node:fs";
import path from "node:path";

const BASE = "https://openapi.kric.go.kr/openapi/convenientInfo";
const LIB = path.join(process.cwd(), "src", "lib");
const OUT = path.join(LIB, "transfer-times-kric.json");
const WALK_SPEED = 1.2; // m/s — 서울교통공사가 환승 소요시간을 낼 때 쓰는 보행속도

// 역 이름 정규화 (앱의 다른 곳과 같은 규칙)
const ALIAS = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s) =>
  String(s || "").replace(/\s/g, "").replace(/[·.]/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();
const nn = (s) => ALIAS[bare(s)] ?? bare(s);

// 노선 이름 통일 (자료마다 표기가 다릅니다)
const LINE_ALIAS = {
  "경의·중앙선": "경의중앙선",
  경의선: "경의중앙선",
  중앙선: "경의중앙선",
  우이신설경전철: "우이신설선",
  서해: "서해선",
  신림: "신림선",
  분당선: "수인분당선",
  수인선: "수인분당선",
  인천선: "인천1호선",
  김포도시철도: "김포골드라인",
  국철: "", // 무엇을 가리키는지 모호합니다 — 역에 있는 노선으로 좁혀서 씁니다
  경원선: "1호선",
  경인선: "1호선",
  경부선: "1호선",
};
const lineName = (s) => {
  const t = String(s || "").trim();
  if (!t) return "";
  if (/^\d+$/.test(t)) return `${t}호선`;
  return LINE_ALIAS[t] ?? t;
};

function apiKey() {
  const env = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(/KRIC_API_KEY=(.*)/);
  const key = m?.[1]?.trim();
  if (!key)
    throw new Error(
      ".env.local 에 KRIC_API_KEY 가 없습니다.\n" +
        "  레일포털(https://data.kric.go.kr) 에 가입해 '역사별 정보'와 '역사별 환승정보'를 활용신청한 뒤\n" +
        "  발급받은 키를 .env.local 에 KRIC_API_KEY=... 로 넣어주세요."
    );
  return key;
}

async function call(op, params) {
  const qs = new URLSearchParams({ format: "json", ...params });
  const res = await fetch(`${BASE}/${op}?${qs}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${op}: JSON이 아닌 응답이 왔습니다 — ${text.slice(0, 200)}`);
  }
  const code = json?.header?.resultCode ?? json?.resultCode;
  // 00 이 정상입니다. 30이면 키가 등록 안 된 것입니다.
  if (code && String(code) !== "00" && String(code) !== "0") {
    const msg = json?.header?.resultMsg ?? json?.resultMsg ?? "";
    throw new Error(`${op}: ${code} ${msg}`);
  }
  // 응답 배열의 이름이 자료마다 달라서, 배열인 값을 찾아 씁니다.
  const body = json?.body ?? json;
  if (Array.isArray(body)) return body;
  for (const v of Object.values(body ?? {})) if (Array.isArray(v)) return v;
  return [];
}

// 노선도에서 "이 역에 어떤 노선이 지나는지"
function linesAtStation() {
  const linemap = JSON.parse(fs.readFileSync(path.join(LIB, "linemap.json"), "utf8"));
  const at = new Map();
  for (const l of linemap) {
    const nameAt = new Map();
    for (const n of l.nodes) if (n.name) nameAt.set(`${n.x},${n.y}`, n.name);
    for (const n of l.nodes) {
      const name = n.name ?? nameAt.get(`${n.x},${n.y}`);
      if (!name) continue;
      const k = nn(name);
      if (!at.has(k)) at.set(k, new Set());
      at.get(k).add(lineName(l.label));
    }
  }
  return at;
}

// 아직 환승 시간이 비어 있는 조합 (역 → 노선쌍)
function missingPairs(at) {
  const read = (f) => {
    const p = path.join(LIB, f);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).stations ?? {} : {};
  };
  const tr = read("transfers.json");
  const walk = read("transfer-times.json");
  const extra = read("transfers-extra.json");
  const out = new Map(); // 역 → Set("A|B")
  for (const [stn, lines] of at) {
    const ls = [...lines].filter(Boolean);
    for (let i = 0; i < ls.length; i++)
      for (let j = 0; j < ls.length; j++) {
        if (i === j) continue;
        const a = ls[i];
        const b = ls[j];
        if (tr[stn]?.[a]?.[b]?.length) continue;
        if (walk[stn]?.[a]?.[b]?.sec) continue;
        if (extra[stn]?.[a]?.[b]) continue;
        if (!out.has(stn)) out.set(stn, new Set());
        out.get(stn).add(`${a}|${b}`);
      }
  }
  return out;
}

// 역 이름으로 (운영기관·선·역코드) 찾기 — 한 역이 여러 노선에 걸쳐 여러 건 나옵니다
async function findStations(key, stinNm) {
  return await call("stationInfo", { serviceKey: key, stinNm });
}

async function main() {
  const args = process.argv.slice(2);
  const probe = args.includes("--probe") ? args[args.indexOf("--probe") + 1] : null;
  const key = apiKey();

  if (probe) {
    // 원본 응답을 그대로 보여줍니다 (항목 이름을 눈으로 확인할 때)
    const stations = await findStations(key, probe);
    console.log(`■ stationInfo(${probe}) — ${stations.length}건`);
    console.log(JSON.stringify(stations, null, 1).slice(0, 2000));
    for (const s of stations.slice(0, 6)) {
      const rows = await call("stationTransferInfo", {
        serviceKey: key,
        railOprIsttCd: s.railOprIsttCd,
        lnCd: s.lnCd,
        stinCd: s.stinCd,
      });
      console.log(`\n■ stationTransferInfo(${s.railOprIsttCd}/${s.lnCd}/${s.stinCd}) — ${rows.length}건`);
      console.log(JSON.stringify(rows, null, 1).slice(0, 1500));
    }
    return;
  }

  const at = linesAtStation();
  const need = missingPairs(at);
  console.log(`환승 시간이 비어 있는 역 ${need.size}곳을 훑습니다`);

  const out = {};
  const coords = {}; // 덤으로 얻는 노선별 역 위경도 (지금은 저장만 해둡니다)
  let filled = 0;
  const unresolved = [];

  for (const [stn, pairs] of need) {
    let stations;
    try {
      stations = await findStations(key, stn);
    } catch (e) {
      console.log(`  ${stn}: 역 정보를 못 받았습니다 — ${e.message}`);
      continue;
    }
    const here = at.get(stn) ?? new Set();
    for (const s of stations) {
      if (nn(s.stinNm) !== stn) continue; // 이름 부분일치로 다른 역이 섞여 올 수 있습니다
      const from = lineName(s.lnCd);
      if (s.stinLocLat && s.stinLocLon)
        coords[`${stn}|${from}`] = { lat: Number(s.stinLocLat), lon: Number(s.stinLocLon) };
      let rows;
      try {
        rows = await call("stationTransferInfo", {
          serviceKey: key,
          railOprIsttCd: s.railOprIsttCd,
          lnCd: s.lnCd,
          stinCd: s.stinCd,
        });
      } catch {
        continue;
      }
      for (const r of rows) {
        const to = lineName(r.chtnLn);
        const m = Number(r.chtnDst);
        if (!to || !Number.isFinite(m) || m <= 0) continue;
        // 노선도로 확인 — 그 역에 실제로 있는 노선끼리만 인정합니다(추측 금지)
        if (!here.has(from) || !here.has(to) || from === to) {
          unresolved.push(`${stn} ${s.lnCd}→${r.chtnLn}`);
          continue;
        }
        if (!pairs.has(`${from}|${to}`) && !pairs.has(`${to}|${from}`)) continue; // 이미 값이 있는 조합
        const sec = Math.round(m / WALK_SPEED);
        for (const [x, y] of [
          [from, to],
          [to, from],
        ]) {
          out[stn] ??= {};
          out[stn][x] ??= {};
          if (out[stn][x][y] == null) out[stn][x][y] = { sec, m };
        }
        filled++;
      }
    }
    await new Promise((r) => setTimeout(r, 120)); // 너무 빠르게 부르지 않기
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify({
      built: new Date().toISOString().slice(0, 10),
      source: "KRIC 역사별 환승정보 (환승거리 ÷ 1.2m/s)",
      stations: out,
      coords,
    })
  );
  let pairs = 0;
  for (const byLine of Object.values(out)) for (const byTo of Object.values(byLine)) pairs += Object.keys(byTo).length;
  console.log(`→ transfer-times-kric.json  역 ${Object.keys(out).length}곳 · 노선쌍 ${pairs}개 (채운 건수 ${filled})`);
  if (unresolved.length)
    console.log(`   (노선도에서 확인이 안 돼 버린 것 ${unresolved.length}개: ${unresolved.slice(0, 6).join(", ")})`);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
