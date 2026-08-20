// 노선별 열차 량수(칸 수)
//
// 노선마다 열차 길이가 다릅니다. 같은 노선 안에서도 지선·셔틀은 더 짧습니다.
//
// 출처(1~9호선): 서울열린데이터광장 "서울교통공사_열차운행현황"(OA-13318)의
//   '열차편성수(1편성당 칸수)' 항목 — 공식 자료로 아래 값을 검증했습니다.
//     1호선 16(10) · 2호선 84(10/6/4) · 3호선 49(10) · 4호선 46(10)
//     5호선 80(8) · 6호선 39(8) · 7호선 72(8) · 8호선 20(6) · 9호선 9(6)
//   ※ 2호선이 10/6/4 세 종류인 점이 아래 지선 처리(성수지선 4량·신정지선 6량)와 일치합니다.
// 출처(그 외 노선): 각 운영기관 자료 + 서울시 미디어허브
//   (https://mediahub.seoul.go.kr/archives/809847)
// 마지막 확인: 2026-08-20
//
// ⚠️ 증차·증결이 있으면 값이 달라집니다(예: 9호선은 4량 → 6량으로 증차됨).

import { shortLine } from "./line-colors";

export const DEFAULT_CARS = 8;

export const LINE_CARS: Record<string, number> = {
  "1호선": 10,
  "2호선": 10,
  "3호선": 10,
  "4호선": 10,
  "5호선": 8,
  "6호선": 8,
  "7호선": 8,
  "8호선": 6,
  "9호선": 6, // 2019년 증차로 일반열차까지 6량
  "경의중앙선": 8,
  "경춘선": 8,
  "공항철도": 6,
  "수인분당선": 6,
  "분당선": 6,
  "신분당선": 6,
  "경강선": 4,
  "서해선": 4,
  "인천1호선": 8,
  "인천2호선": 2,
  "우이신설선": 2,
  "신림선": 3,
  "김포골드라인": 2,
  "의정부경전철": 2,
  "용인경전철": 1, // 에버라인은 1량
  "에버라인": 1,
  "GTX-A": 8,
};

// 같은 노선인데 량수가 다른 계통(지선·셔틀).
// 그 계통에서만 다니는 역이 경로에 들어 있으면 해당 계통으로 봅니다.
type Special = {
  line: string;
  cars: number;
  label: string;
  onlyStations: string[]; // 이 계통에서만 정차하는 역
};

const SPECIALS: Special[] = [
  // 영등포~광명 셔틀 (4량). 광명역은 이 셔틀만 정차합니다.
  { line: "1호선", cars: 4, label: "광명셔틀", onlyStations: ["광명"] },
  // 2호선 성수지선 (4량)
  { line: "2호선", cars: 4, label: "성수지선", onlyStations: ["용답", "신답", "용두", "신설동"] },
  // 2호선 신정지선 (6량)
  { line: "2호선", cars: 6, label: "신정지선", onlyStations: ["도림천", "양천구청", "신정네거리", "까치산"] },
  // 경의중앙선 문산~서울역 지선 (4량). 서울역은 이 계통만 들어갑니다.
  { line: "경의중앙선", cars: 4, label: "서울역 지선", onlyStations: ["서울역"] },
];

export type CarInfo = {
  cars: number;
  label?: string; // "광명셔틀"처럼 특별한 계통일 때만
  known: boolean; // 노선 자료가 있는지 (없으면 기본값을 쓴 것)
};

// 이 구간이 몇 량짜리 열차인지
export function carsForLeg(line: string, stations: (string | undefined)[]): CarInfo {
  const key = shortLine(line);
  const names = new Set(stations.filter(Boolean) as string[]);

  for (const s of SPECIALS) {
    if (s.line !== key) continue;
    if (s.onlyStations.some((n) => names.has(n))) {
      return { cars: s.cars, label: s.label, known: true };
    }
  }

  const cars = LINE_CARS[key];
  return cars ? { cars, known: true } : { cars: DEFAULT_CARS, known: false };
}
