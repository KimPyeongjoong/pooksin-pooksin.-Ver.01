// 레일포털(KRIC) "역사별 환승정보" 조사 — 환승 거리 수집 시도
//
// ⚠️ 결론부터: **이 자료로는 환승 시간을 채울 수 없습니다.** (2026-08-26 전수 확인)
//    환승거리 항목 `chtnDst` 가 **전국 1049행 전부 null** 입니다. 항목 이름만 있고 값이 없습니다.
//    서울·부산·대구·인천·코레일·공항철도 등 46개 노선 1108개 역을 하나도 빼지 않고 확인했습니다.
//    → 아래 main() 은 이 상태를 **다시 확인만** 합니다. 언젠가 레일포털이 값을 채우면
//      그때는 자동으로 감지해서 예전 계획대로 파일을 만듭니다.
//
// 원래 계획이 무엇이었나:
//   환승 시간은 지금 두 자료로 채웁니다(scripts/build-transfers.mjs 참고).
//     ① 서울교통공사 환승정보(OA-22521)  ② 서울교통공사 환승역거리(OA-13290)
//   둘 다 **서울교통공사 자료**라, 양쪽 다 서울교통공사가 아닌 환승은 비어 있습니다.
//   회기 · 용산 · 부평 · 김포공항 · 판교 · GTX 환승 등 **116개 조합이 아직 3분 상수**입니다.
//   레일포털은 전국 철도운영기관을 덮으니 환승거리를 받아
//   서울교통공사와 같은 기준(환승거리 ÷ 1.2m/s)으로 환산해 채우려 했습니다.
//   거리 값이 없어서 무산됐습니다.
//
// 좌표로 대신 재보는 것도 안 됩니다:
//   stationInfo 의 역 좌표는 노선별로 따로 있긴 한데 **승강장이 아니라 역 대표점**입니다.
//   김포공항 공항철도↔9호선이 10m, 용산 1호선↔경의중앙이 0m 로 나옵니다.
//   (실제로는 몇 분 걸리는 환승입니다.) 3분 상수보다 더 나쁜 값이 됩니다.
//
// 그래도 건진 것 — 환승 **승차위치**:
//   stationTransferInfo 응답의 `stLocCont`(예: "2호선 5번 칸 2번 문") · `clsLocCont`(예: "신분당선[양재 방면]")
//   는 값이 제대로 들어 있습니다. 전국 217개 역 1049행. 환승 시간과는 별개지만 이 앱 주제에 맞습니다.
//   쓰려면 --dump 로 원본을 받아두세요.
//
// 알아낸 API 사용법 (문서에 안 적혀 있어 직접 찾은 것):
//   · 역 이름으로는 못 찾습니다. `stinNm` 같은 검색 파라미터는 없습니다.
//     반드시 **운영기관코드 + 노선코드 + 역코드**로 불러야 합니다.
//   · 코드값은 레일포털 자료실의 엑셀에 있습니다 → scripts/kric-station-codes.json 으로 옮겨뒀습니다.
//       원본: data/kric-station-codes.xlsx
//       출처: https://data.kric.go.kr/rips/M_04_02/detail.do?id=17 (운영기관_역사_코드정보_2026.07.11_일반.xlsx)
//     노선코드는 "S1" 같은 게 아니라 "1"·"K4"(경의중앙)·"I1"(인천1호선)·"A1"(공항철도) 형태입니다.
//   · stationInfo 는 stinCd 를 줘도 **그 노선 전체**를 돌려줍니다 (노선당 한 번만 부르면 됩니다).
//   · stationTransferInfo 는 stinCd 가 **필수**입니다. 빼면 "데이터가 없습니다"가 옵니다.
//   · format 파라미터는 필수입니다 (빼면 HTTP 400).
//   · 서비스키를 안 보내거나 틀리면 resultCode 30, 조건에 맞는 행이 없으면 03 입니다.
//     30 이 아니라 03 이 오면 **키는 정상이고 조회 조건이 틀린 것**입니다.
//
// 실행: (poogsin 폴더에서)
//   node scripts/build-transfers-kric.mjs            환승거리가 채워졌는지 다시 확인
//   node scripts/build-transfers-kric.mjs --probe 회기   한 역만 원본 응답 그대로 보기
//   node scripts/build-transfers-kric.mjs --dump     환승 승차위치 원본을 파일로 저장
//
// 결과: src/lib/transfer-times-kric.json (거리 값이 생겼을 때만)
//   경로검색은 ①환승정보 → ②환승역거리 → ③이 파일 → ④예전 보충값 → ⑤3분 상수 순으로 씁니다.

import fs from "node:fs";
import path from "node:path";

const BASE = "https://openapi.kric.go.kr/openapi/convenientInfo";
const LIB = path.join(process.cwd(), "src", "lib");
const OUT = path.join(LIB, "transfer-times-kric.json");
const DUMP = path.join(process.cwd(), "data", "kric-transfer-raw.json");
const CODES = path.join(process.cwd(), "scripts", "kric-station-codes.json");
const WALK_SPEED = 1.2; // m/s — 서울교통공사가 환승 소요시간을 낼 때 쓰는 보행속도

// 역 이름 정규화 (앱의 다른 곳과 같은 규칙)
const ALIAS = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s) =>
  String(s || "").replace(/\s/g, "").replace(/[·.]/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();
const nn = (s) => ALIAS[bare(s)] ?? bare(s);

// 레일포털 노선코드 → 앱에서 쓰는 노선 이름
const LN_CD = {
  1: "1호선", 2: "2호선", 3: "3호선", 4: "4호선", 5: "5호선",
  6: "6호선", 7: "7호선", 8: "8호선", 9: "9호선",
  A: "GTX-A", A1: "공항철도", D1: "신분당선", G1: "김포골드라인",
  I1: "인천1호선", I2: "인천2호선", K1: "수인분당선", K2: "경춘선",
  K4: "경의중앙선", K5: "경강선", K6: "동해선", K7: "대경선",
  L1: "신림선", UI: "우이신설선", WS: "서해선", E1: "에버라인",
  M1: "자기부상", U1: "의정부경전철", B1: "부산김해경전철",
};
const lineName = (cd) => LN_CD[String(cd || "").trim()] ?? "";

function apiKey() {
  const env = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const key = env.match(/^KRIC_API_KEY=(.*)$/m)?.[1]?.trim();
  if (!key)
    throw new Error(
      ".env.local 에 KRIC_API_KEY 가 없습니다.\n" +
        "  레일포털(https://data.kric.go.kr) 에 가입해 '역사별 정보'와 '역사별 환승정보'를 활용신청한 뒤\n" +
        "  발급받은 키를 .env.local 에 KRIC_API_KEY=... 로 넣어주세요."
    );
  return key;
}

async function call(op, params) {
  const qs = new URLSearchParams({ serviceKey: apiKey(), format: "json", ...params });
  const res = await fetch(`${BASE}/${op}?${qs}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${op}: JSON이 아닌 응답이 왔습니다 — ${text.slice(0, 200)}`);
  }
  const code = String(json?.header?.resultCode ?? "");
  if (code === "03") return []; // 조건에 맞는 행이 없음 (키 문제가 아닙니다)
  if (code !== "00") throw new Error(`${op}: ${code} ${json?.header?.resultMsg ?? ""}`);
  return json.body ?? [];
}

const codeTable = () => JSON.parse(fs.readFileSync(CODES, "utf8"));

// 전국 역을 훑으며 환승정보 원본을 모읍니다 (1108번 호출 — 2~3분 걸립니다)
async function crawl(onTick) {
  const rows = [];
  const codes = codeTable();
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    let body = [];
    try {
      body = await call("stationTransferInfo", { railOprIsttCd: c.oprCd, lnCd: c.lnCd, stinCd: c.stinCd });
    } catch {
      /* 한 역 실패는 넘어갑니다 */
    }
    for (const r of body) rows.push({ ...c, ...r });
    onTick?.(i + 1, codes.length, rows.length);
    await new Promise((r) => setTimeout(r, 60)); // 너무 빠르게 부르지 않기
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const probe = args.includes("--probe") ? args[args.indexOf("--probe") + 1] : null;

  if (probe) {
    const hits = codeTable().filter((c) => nn(c.stinNm) === nn(probe));
    if (!hits.length) return console.log(`코드표에 "${probe}" 가 없습니다.`);
    for (const c of hits) {
      console.log(`\n■ ${c.stinNm} — ${c.oprNm} ${c.lnNm} (${c.oprCd}/${c.lnCd}/${c.stinCd})`);
      const rows = await call("stationTransferInfo", { railOprIsttCd: c.oprCd, lnCd: c.lnCd, stinCd: c.stinCd });
      console.log(rows.length ? JSON.stringify(rows, null, 1) : "  환승정보 없음");
    }
    return;
  }

  const tick = (i, n, r) => i % 150 === 0 && console.log(`  ${i}/${n} (${r}행)`);
  console.log("전국 역사별 환승정보를 훑습니다 (2~3분)");
  const rows = await crawl(tick);
  const withDst = rows.filter((r) => r.chtnDst != null && r.chtnDst !== "");
  console.log(`\n환승정보 ${rows.length}행 · 그중 환승거리(chtnDst)가 있는 행 ${withDst.length}개`);

  if (args.includes("--dump")) {
    fs.mkdirSync(path.dirname(DUMP), { recursive: true });
    fs.writeFileSync(DUMP, JSON.stringify({ built: new Date().toISOString().slice(0, 10), rows }));
    console.log(`→ ${path.relative(process.cwd(), DUMP)} (환승 승차위치 원본)`);
  }

  if (!withDst.length) {
    console.log(
      "\n환승거리가 여전히 전부 비어 있습니다. 이 자료로는 환승 시간을 채울 수 없습니다.\n" +
        "  경로검색은 지금처럼 서울교통공사 자료 + 3분 상수로 돌아갑니다 (파일은 건드리지 않았습니다).\n" +
        "  자세한 사정은 이 파일 맨 위 주석을 보세요."
    );
    return;
  }

  // ── 여기부터는 레일포털이 언젠가 거리 값을 채웠을 때만 돕니다 ──
  const out = {};
  let filled = 0;
  for (const r of withDst) {
    const stn = nn(r.stinNm);
    const from = lineName(r.lnCd);
    const to = lineName(r.chtnLn);
    const m = Number(r.chtnDst);
    if (!from || !to || from === to || !Number.isFinite(m) || m <= 0) continue;
    const sec = Math.round(m / WALK_SPEED);
    for (const [x, y] of [[from, to], [to, from]]) {
      out[stn] ??= {};
      out[stn][x] ??= {};
      if (out[stn][x][y] == null) out[stn][x][y] = { sec, m };
    }
    filled++;
  }
  fs.writeFileSync(
    OUT,
    JSON.stringify({
      built: new Date().toISOString().slice(0, 10),
      source: "KRIC 역사별 환승정보 (환승거리 ÷ 1.2m/s)",
      stations: out,
    })
  );
  let pairs = 0;
  for (const byLine of Object.values(out)) for (const byTo of Object.values(byLine)) pairs += Object.keys(byTo).length;
  console.log(`→ transfer-times-kric.json  역 ${Object.keys(out).length}곳 · 노선쌍 ${pairs}개 (채운 건수 ${filled})`);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
