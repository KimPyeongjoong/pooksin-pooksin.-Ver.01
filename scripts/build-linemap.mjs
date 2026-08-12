// 서울교통공사 사이버스테이션의 노선도 데이터(getLineData.do)를 받아
// 우리 앱에서 그리기 좋은 형태(src/lib/linemap.json)로 변환합니다. (1회성)
//
// ⚠️ 이 데이터는 서울교통공사 자체 데이터입니다. 프로토타입용으로 사용하며,
//    상용화 전에는 사용 권리(라이선스/이용약관)를 확인해야 합니다.
//
// 실행: (poogsin 폴더에서)  node scripts/build-linemap.mjs

import fs from "node:fs";
import path from "node:path";

const URL = "http://www.seoulmetro.co.kr/kr/getLineData.do";

const res = await fetch(URL, {
  headers: {
    "User-Agent": "Mozilla/5.0",
    Referer: "http://www.seoulmetro.co.kr/kr/cyberStation.do",
  },
});
const text = await res.text();

// "var lines = { ... };" 에서 객체 부분만 뽑아내기
const start = text.indexOf("{");
const end = text.lastIndexOf("}");
let objText = text.slice(start, end + 1);
// 트레일링 콤마 제거 (JS 객체 → 유효한 JSON)
objText = objText.replace(/,(\s*[}\]])/g, "$1");

const lines = JSON.parse(objText);

const out = [];
for (const [key, val] of Object.entries(lines)) {
  const attr = val.attr || {};
  const color = (attr["data-color"] || "#888888").toLowerCase();
  const label = attr["data-label"] || key;
  // 흰색 라인은 이중선 casing(장식)이라 건너뜀 (역 중복도 방지)
  if (color === "#ffffff" || color === "#fff") continue;
  // 한강버스(수상버스)는 지하철이 아니므로 제외
  if (label.includes("한강버스")) continue;

  const nodes = [];
  for (const s of val.stations || []) {
    const mv = s["data-moveTo"];
    // 펜 이동(moveTo) 노드는 data-coords가 없을 수 있음 → moveTo 좌표를 사용
    const coordStr = mv || s["data-coords"];
    if (!coordStr) continue;
    const [x, y] = coordStr.split(",").map(Number);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    const node = { x, y };
    if (mv) node.m = true; // 선 끊김(새 구간 시작)
    if (s["data-nodeType"] === "indicator") node.ind = true;
    const nm = (s["station-nm"] || "").trim();
    if (nm) {
      node.name = nm;
      if (s["station-cd"]) node.cd = s["station-cd"];
      if (s["data-labelPos"]) node.lp = s["data-labelPos"];
      if (s["data-marker"]) node.mk = s["data-marker"];
    }
    nodes.push(node);
  }
  if (nodes.length === 0) continue;
  out.push({
    key,
    label,
    indicator: attr["data-indicator-text"] || label, // 종점 뱃지 텍스트 (예: "2", "경춘")
    color,
    width: Number(attr["data-lineWidth"] || 2),
    nodes,
  });
}

const outPath = path.resolve("src/lib/linemap.json");
fs.writeFileSync(outPath, JSON.stringify(out));

const stationCount = out.reduce((a, l) => a + l.nodes.filter((n) => n.name).length, 0);
console.log(`노선 ${out.length}개, 역 마커 ${stationCount}개 → src/lib/linemap.json`);
console.log("노선 목록:", out.map((l) => l.label).join(", "));
