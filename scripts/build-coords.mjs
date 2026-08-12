// 전체 역 좌표 수집 스크립트 (한 번만 실행)
// ODsay searchStation으로 각 역의 위경도를 받아 src/lib/station-coords.json에 저장합니다.
// 이미 받은 역은 건너뛰므로, 중간에 멈춰도 다시 실행하면 이어서 받습니다.
//
// 실행: (poogsin 폴더에서)  $env:ODSAY_API_KEY="키"; node scripts/build-coords.mjs

import fs from "node:fs";
import path from "node:path";

const KEY = process.env.ODSAY_API_KEY;
if (!KEY) {
  console.error("ODSAY_API_KEY 환경변수가 없습니다.");
  process.exit(1);
}
const enc = encodeURIComponent(KEY);

const root = path.resolve(".");
const stationsPath = path.join(root, "src/lib/stations.json");
const outPath = path.join(root, "src/lib/station-coords.json");

const stations = JSON.parse(fs.readFileSync(stationsPath, "utf8"));
const names = [...new Set(stations.map((s) => s.name))];

let out = {};
if (fs.existsSync(outPath)) {
  try {
    out = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let done = 0,
  added = 0,
  fail = 0;

for (const name of names) {
  done++;
  if (out[name]) continue;
  try {
    const url =
      `https://api.odsay.com/v1/api/searchStation?apiKey=${enc}` +
      `&stationName=${encodeURIComponent(name)}&stationClass=2`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error(`ERR@${name}: ${data.error.code} ${data.error.message}`);
      // 사용량 초과/권한 오류로 보이면 중단하고 저장 (다음에 이어서)
      const msg = String(data.error.message || "");
      if (msg.includes("허용") || msg.includes("초과") || data.error.code === "500") break;
      continue;
    }
    const list = data.result?.station ?? [];
    const exact = list.find((s) => s.stationName === name) ?? list[0];
    if (exact && exact.x && exact.y) {
      out[name] = { x: Number(exact.x), y: Number(exact.y) };
      added++;
    }
  } catch (e) {
    fail++;
    console.error(`FAIL@${name}: ${e.message}`);
  }
  if (done % 50 === 0) {
    fs.writeFileSync(outPath, JSON.stringify(out));
    console.log(`${done}/${names.length}  (수집 ${Object.keys(out).length}, 실패 ${fail})`);
  }
  await sleep(120);
}

fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`완료: ${done}/${names.length}, 좌표 ${Object.keys(out).length}개 (이번 추가 ${added}, 실패 ${fail})`);
