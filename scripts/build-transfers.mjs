// 환승 정보 수집 스크립트 (자료가 갱신되면 다시 실행하면 됩니다)
//
// 무엇을 주는가:
//   환승역에서 "몇 호차 몇 번 문으로 내려서, 몇 분 걸어, 몇 호차 몇 번 문으로 타는지".
//   ODsay만 주는 줄 알았던 "빠른 환승 칸"과 "환승 소요시간"이 여기 다 들어 있습니다.
//
// 출처: 서울열린데이터광장 "서울교통공사_서울 도시철도 환승정보" (OA-22521)
//   같은 자료가 공공데이터포털에도 있습니다(15097652 API / 15098252 파일).
//   **인증키가 필요 없습니다** — CSV를 그대로 내려받습니다.
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
const lineOf = (raw) => LINE_NAME[String(raw).trim()] ?? String(raw).trim();

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

async function main() {
  console.log("내려받는 중…");
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      Referer: "https://data.seoul.go.kr/dataList/OA-22521/F/1/datasetView.do",
    },
    body: FORM,
  });
  if (!res.ok) throw new Error(`내려받기 실패 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 이 파일은 EUC-KR 입니다.
  let text = new TextDecoder("euc-kr").decode(buf);
  if (!/[가-힣]/.test(text)) text = buf.toString("utf8");

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
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
