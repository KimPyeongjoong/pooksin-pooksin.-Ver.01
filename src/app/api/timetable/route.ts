// 지하철역 "실제 시간표" 서버 경로
//
// 호출 예: /api/timetable?station=종로3가&line=5호선
//
// 전부 앱에 내장된 자료로 답합니다. 외부 호출이 없습니다.
//   원본: 공공데이터포털 "서울교통공사_열차시간표"(15143847)를
//         scripts/build-timetable.mjs 로 미리 받아 src/lib/timetable/ 에 넣어둔 것.
//   수도권 24개 노선 654개 역을 전부 덮습니다.
//
// ⚠️ ODsay는 쓰지 않습니다. 무료 플랜이 하루 30건으로 바뀌어 못 씁니다.
//
// 돌려주는 것:
//   평일 / 토요일 / 휴일 × 상행·하행 시간표 전부 + 오늘이 어느 쪽인지.
//   (화면에서 탭을 눌러 바꿀 때 다시 부르지 않아도 되도록 한 번에 다 보냅니다.)
//   토요일과 휴일은 같은 시간표입니다 — 실제로 동일함을 확인했습니다
//   (강남 2호선 토 197편 = 일 197편, 시각까지 일치).

import { dayTypeOf, holidayDataCovers, isHoliday, kstDateKey, type DayType } from "@/lib/holidays";
import { lineColor, shortLine } from "@/lib/line-colors";
import { linesAtStation } from "@/lib/lines";
import { isCovered, stationTimetable } from "@/lib/timetable";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const stationName = searchParams.get("station");
  const lineParam = searchParams.get("line");

  if (!stationName) {
    return Response.json({ error: "역 이름이 필요해요" }, { status: 400 });
  }

  const today: DayType = dayTypeOf();

  // 이 역에 어떤 노선이 지나는지도 내장 노선도로 만듭니다.
  const here = linesAtStation(stationName).map((l) => shortLine(l.label));
  const siblings = here.map((line, i) => ({ stationID: i, line }));
  // 요청한 노선이 없으면, 그 역에서 시간표가 있는 첫 노선을 씁니다.
  const want = lineParam ? shortLine(lineParam) : (here.find((l) => isCovered(l)) ?? here[0]);

  if (want && isCovered(want)) {
    const t = await stationTimetable(stationName, want);
    if (t) {
      return Response.json({
        stationName,
        line: t.line,
        color: lineColor(t.line),
        upWay: t.upWay,
        downWay: t.downWay,
        today,
        isHoliday: isHoliday(),
        dateKey: kstDateKey(),
        holidayDataStale: !holidayDataCovers(),
        built: t.built, // 시간표를 받아둔 날짜
        lists: t.lists,
        siblings,
      });
    }
  }

  return Response.json({
    error: `${stationName}${want ? ` ${want}` : ""} 시간표를 찾지 못했어요`,
    siblings,
  });
}
