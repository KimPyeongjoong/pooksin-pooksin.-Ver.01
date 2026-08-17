// 노선 이름 → 대표 색상 (여러 곳에서 같은 색을 쓰도록 한곳에 모았습니다)

export const LINE_COLORS: Record<string, string> = {
  "1호선": "#0052A4", "2호선": "#00A84D", "3호선": "#EF7C1C", "4호선": "#00A5DE",
  "5호선": "#996CAC", "6호선": "#CD7C2F", "7호선": "#747F00", "8호선": "#E6186C",
  "9호선": "#BDB092", "신분당선": "#D31145", "수인분당선": "#FABE00", "분당선": "#FABE00",
  "경의중앙선": "#77C4A3", "공항철도": "#0090D2", "경춘선": "#0C8E72", "경강선": "#003DA5",
  "서해선": "#8FC31F", "우이신설선": "#B7C452", "김포골드라인": "#AD8605", "신림선": "#6789CA",
  "인천1호선": "#7CA8D5", "인천2호선": "#ED8B00", "의정부경전철": "#FDA600", "용인경전철": "#509F22",
  "에버라인": "#509F22", "자기부상철도": "#FFCD12", "GTX-A": "#9A6292",
};

// ODsay는 "수도권 2호선", "인천 1호선"처럼 지역을 붙여서 줍니다. 이를 정리합니다.
export function shortLine(name: string): string {
  return (name || "")
    .replace(/^수도권\s*/, "")
    .replace(/^인천\s*(\d)/, "인천$1")
    .trim();
}

export function lineColor(name: string): string {
  return LINE_COLORS[shortLine(name)] ?? "#6B7280";
}
