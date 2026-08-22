// 실제 운임 조회
//
// 출처: 공공데이터포털 "서울교통공사_실시간운임정보" (15143846)
//   https://apis.data.go.kr/B553766/fare2/getRltmFare2
//   키: .env.local 의 SEOUL_METRO_API_KEY · 하루 10,000건
//
// 왜 API로 부르나:
//   전체가 40만 건(모든 역 조합)이라 앱에 통째로 넣기엔 큽니다.
//   대신 검색한 구간만 물어보고, 결과를 오래 담아둡니다.
//   운임은 자주 바뀌지 않아서(응답의 crtrYmd가 기준일자) 캐시가 잘 듣습니다.
//
// 이걸 붙이기 전에는 거리비례 공식으로 어림잡았는데,
// 신분당선 추가요금(최대 2,200원)·의정부경전철 200원·공항철도 할인 같은 걸
// 반영할 수 없었습니다. 이제 공식 값입니다.

const API = "https://apis.data.go.kr/B553766/fare2/getRltmFare2";

export type Fare = {
  card: number; // 일반 카드
  cash: number; // 일반 현금
  youth: number; // 청소년 카드
  child: number; // 어린이 카드
  addFare: number; // 추가요금 (신분당선 등)
  distanceKm: number;
  climateCard: boolean; // 기후동행카드 사용 가능 여부
  basedOn: string; // 기준일자 (YYYYMMDD)
};

const tag = (blk: string, k: string) =>
  (blk.match(new RegExp(`<${k}>([^<]*)</${k}>`)) || [])[1] ?? "";

// 역 이름 정규화 (다른 파일들과 같은 규칙)
const ALIAS: Record<string, string> = { 이수: "총신대입구", 서해구청: "서구청" };
const bare = (s: string) =>
  (s || "").replace(/\s/g, "").replace(/\([^)]*\)/g, "").replace(/역$/, "").trim();
const norm = (s: string) => ALIAS[bare(s)] ?? bare(s);

// 성공한 결과만 담아둡니다.
// ⚠️ fetch 단계 캐시를 쓰지 않는 이유는 /api/route 와 같습니다 —
//    한도 초과나 오류 응답까지 캐시되면 회복된 뒤에도 계속 실패합니다.
const cache = new Map<string, { at: number; fare: Fare }>();
const CACHE_MS = 12 * 60 * 60 * 1000; // 12시간

export async function lookupFare(from: string, to: string): Promise<Fare | null> {
  const key = process.env.SEOUL_METRO_API_KEY;
  if (!key) return null;

  const ck = `${norm(from)}→${norm(to)}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.fare;

  const qs = new URLSearchParams({
    numOfRows: "50",
    pageNo: "1",
    dptreStnNm: from,
    arvlStnNm: to,
  });
  try {
    const res = await fetch(`${API}?serviceKey=${key}&${qs}`);
    if (!res.ok) return null;
    const text = await res.text();
    if (tag(text, "resultCode") && tag(text, "resultCode") !== "00") return null;

    // ⚠️ 역 이름이 부분일치라 "강남"으로 물으면 "강남구청"도 같이 옵니다.
    //    (열차시간표 API의 stnNm과 같은 성질입니다) 정확히 일치하는 것만 고릅니다.
    for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const blk = m[1];
      if (norm(tag(blk, "dptreStnNm")) !== norm(from)) continue;
      if (norm(tag(blk, "arvlStnNm")) !== norm(to)) continue;
      const num = (k: string) => Number(tag(blk, k)) || 0;
      const fare: Fare = {
        card: num("gnrlCardFare"),
        cash: num("gnrlCashFare"),
        youth: num("yungCardFare"),
        child: num("childCardFare"),
        addFare: num("gnrlAddFare"),
        distanceKm: num("mvmnDstc"),
        climateCard: tag(blk, "clmtcmpnCardTkcarYn") === "Y",
        basedOn: tag(blk, "crtrYmd"),
      };
      if (!fare.card) return null;
      cache.set(ck, { at: Date.now(), fare });
      return fare;
    }
    return null;
  } catch {
    return null; // 못 받으면 부르는 쪽에서 거리 공식으로 대체합니다
  }
}
