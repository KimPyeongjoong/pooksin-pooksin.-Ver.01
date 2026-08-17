// "오늘은 평일 시간표인가, 토요일인가, 휴일인가?"를 판정합니다.
//
// 지하철 시간표는 평일 / 토요일 / 휴일(일요일·공휴일) 세 가지로 나뉩니다.
// 공휴일 목록은 scripts/build-holidays.mjs 로 받아둔 holidays.json을 씁니다.
// (대체공휴일 포함. 목록이 오래되면 스크립트를 다시 실행하세요.)

import raw from "./holidays.json";

const HOLIDAYS = new Set(raw as string[]);

export type DayType = "weekday" | "sat" | "sun";

export const DAY_LABEL: Record<DayType, string> = {
  weekday: "평일",
  sat: "토요일",
  sun: "공휴일",
};

// 서버가 어느 나라에 있든 한국 시간 기준으로 날짜를 계산합니다.
function kstDate(at: Date = new Date()): Date {
  return new Date(at.getTime() + 9 * 60 * 60 * 1000);
}

// "2026-08-17" 형태
export function kstDateKey(at: Date = new Date()): string {
  const d = kstDate(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

export function isHoliday(at: Date = new Date()): boolean {
  return HOLIDAYS.has(kstDateKey(at));
}

// 공휴일 목록이 그 해까지 들어있는지 (없으면 판정을 믿을 수 없음)
export function holidayDataCovers(at: Date = new Date()): boolean {
  const year = kstDateKey(at).slice(0, 4);
  for (const d of HOLIDAYS) if (d.startsWith(year)) return true;
  return false;
}

export function dayTypeOf(at: Date = new Date()): DayType {
  if (isHoliday(at)) return "sun"; // 공휴일은 휴일(일요일) 시간표
  const day = kstDate(at).getUTCDay();
  if (day === 0) return "sun";
  if (day === 6) return "sat";
  return "weekday";
}

// 한국 시간 기준 자정부터 흐른 분
export function kstMinutes(at: Date = new Date()): number {
  const d = kstDate(at);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
