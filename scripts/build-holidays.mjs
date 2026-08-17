// 대한민국 공휴일 수집 스크립트 (가끔 다시 실행하면 됩니다)
//
// 왜 필요한가:
//   지하철 시간표는 "평일 / 토요일 / 휴일" 세 가지로 나뉩니다.
//   공휴일에는 일요일 시간표로 다닙니다. 그런데 대체공휴일(예: 2026-08-17 광복절 대체)은
//   달력만 봐서는 알 수 없어서, 공휴일 목록을 미리 받아 앱에 넣어둡니다.
//
// 출처: 구글 공개 캘린더 "대한민국의 휴일" (키 불필요)
// 실행: (poogsin 폴더에서)  node scripts/build-holidays.mjs

import fs from "node:fs";
import path from "node:path";

const ICS =
  "https://calendar.google.com/calendar/ical/" +
  "ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics";

// 관공서 공휴일(=지하철이 휴일 시간표로 다니는 날)만 남깁니다.
// 제헌절·노동절·식목일·스승의날 등은 공휴일이 아니라 평일 운행입니다.
const HOLIDAY_NAMES = [
  "새해첫날", "신정",
  "설날", "설날 연휴",
  "삼일절",
  "어린이날",
  "부처님오신날",
  "현충일",
  "광복절",
  "추석", "추석 연휴",
  "개천절",
  "한글날",
  "크리스마스",
];

// 대체공휴일은 "쉬는 날 광복절"처럼 앞에 "쉬는 날"이 붙어서 옵니다.
// 선거일도 법정 공휴일입니다.
function isHolidayName(name) {
  const n = name.trim();
  // 대체공휴일 표기가 해마다 달라서 두 가지를 모두 받습니다.
  // ("쉬는 날 광복절", "추석 (대체공휴일)", "석가탄신일 대체공휴일")
  if (n.startsWith("쉬는 날")) return true;
  if (n.includes("대체공휴일")) return true;
  if (n.includes("임시공휴일")) return true;
  // 공직선거일도 법정 공휴일 ("지방선거일", "대통령 선거", "국회의원 선거")
  if (/선거일?$/.test(n)) return true;
  return HOLIDAY_NAMES.includes(n);
}

const res = await fetch(ICS);
if (!res.ok) {
  console.error(`캘린더를 받지 못했습니다 (HTTP ${res.status})`);
  process.exit(1);
}
const text = await res.text();

// VEVENT 블록마다 날짜와 이름을 뽑습니다.
const events = [...text.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) => {
  const block = m[1];
  const date = block.match(/DTSTART;VALUE=DATE:(\d{8})/)?.[1] ?? "";
  const name = block.match(/SUMMARY:([^\r\n]+)/)?.[1] ?? "";
  return { date, name: name.trim() };
});

const kept = new Map();
const skipped = new Set();
for (const { date, name } of events) {
  if (!date) continue;
  if (!isHolidayName(name)) {
    skipped.add(name);
    continue;
  }
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  kept.set(iso, name);
}

const sorted = [...kept.keys()].sort();
const outPath = path.resolve("src/lib/holidays.json");
fs.writeFileSync(outPath, JSON.stringify(sorted, null, 0));

const years = [...new Set(sorted.map((d) => d.slice(0, 4)))];
console.log(`공휴일 ${sorted.length}일 저장 → src/lib/holidays.json`);
console.log(`연도 범위: ${years[0]} ~ ${years[years.length - 1]}`);
console.log(`제외한 기념일: ${[...skipped].join(", ")}`);
const thisYear = sorted.filter((d) => d.startsWith(String(new Date().getFullYear())));
console.log(`올해 공휴일: ${thisYear.map((d) => `${d}(${kept.get(d)})`).join(", ")}`);
