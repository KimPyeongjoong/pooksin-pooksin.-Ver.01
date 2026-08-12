"use client";

// 지도(개략도) — 실제 노선도는 나중에 지도 API로 교체합니다.
// 지금은 구조/흐름 검토용 스키매틱입니다. '갈산' 역을 누를 수 있습니다.

type Props = {
  onStationClick?: () => void; // 갈산역 클릭
  showDep?: boolean; // 출발 핀
  showArr?: boolean; // 도착 핀
  highlightRoute?: boolean; // 경로 강조선
};

export default function MapView({ onStationClick, showDep, showArr, highlightRoute }: Props) {
  return (
    <div className="maparea">
      <svg viewBox="0 0 300 320" preserveAspectRatio="xMidYMid slice" aria-label="노선도">
        <rect width="300" height="320" fill="var(--mapbg)" />
        {/* 노선 */}
        <path d="M70 20 L70 300" fill="none" stroke="var(--l-orange)" strokeWidth="5" strokeLinecap="round" />
        <path d="M20 165 L280 165" fill="none" stroke="var(--l-blue)" strokeWidth="5" strokeLinecap="round" />
        <path
          d="M110 65 C 210 65 250 125 210 195 C 180 245 120 245 100 220"
          fill="none"
          stroke="var(--l-olive)"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path d="M245 25 L245 260" fill="none" stroke="var(--l-purple)" strokeWidth="5" strokeLinecap="round" />

        {/* 경로 강조 (갈산→부평구청→신중동) */}
        {highlightRoute && (
          <path
            d="M70 128 L70 165 L150 165"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="6"
            strokeLinecap="round"
            opacity="0.85"
          />
        )}

        {/* 일반 역 */}
        <g fill="var(--surface)" stroke="var(--l-orange)" strokeWidth="2.4">
          <circle cx="70" cy="75" r="4" />
          <circle cx="70" cy="220" r="4" />
          <circle cx="70" cy="255" r="4" />
        </g>
        <g fill="var(--surface)" stroke="var(--l-olive)" strokeWidth="2.4">
          <circle cx="150" cy="70" r="4" />
          <circle cx="205" cy="128" r="4" />
        </g>
        <g fill="var(--surface)" stroke="var(--l-blue)" strokeWidth="2.4">
          <circle cx="120" cy="165" r="4" />
          <circle cx="200" cy="165" r="4" />
        </g>

        {/* 갈산 (클릭 가능) */}
        <g className="station-hit" onClick={onStationClick}>
          {/* 클릭 영역을 넓히기 위한 투명 원 */}
          <circle cx="70" cy="128" r="18" fill="transparent" />
          <circle cx="70" cy="128" r="7" fill="var(--surface)" stroke="var(--l-orange)" strokeWidth="3.4" />
          <text className="map-stlabel" x="84" y="132" fontSize="12">
            강남
          </text>
        </g>

        {/* 부평구청(환승) / 신중동 / 작전 */}
        <circle cx="70" cy="165" r="7" fill="var(--surface)" stroke="var(--ink)" strokeWidth="3" />
        <text className="map-stlabel" x="84" y="160" fontSize="11">
          부평구청
        </text>
        <circle cx="150" cy="165" r="6" fill="var(--surface)" stroke="var(--l-blue)" strokeWidth="2.6" />
        <text className="map-stlabel dim" x="150" y="186" fontSize="11" textAnchor="middle">
          신중동
        </text>
        <text className="map-stlabel dim" x="84" y="79" fontSize="11">
          작전
        </text>
      </svg>

      {/* 출발/도착 핀 (갈산=출발, 신중동=도착 위치 근사) */}
      {showDep && (
        <div className="pin-mark dep" style={{ left: "23.3%", top: "40%" }}>
          <span className="drop">
            <b>출</b>
          </span>
        </div>
      )}
      {showArr && (
        <div className="pin-mark arr" style={{ left: "50%", top: "51.5%" }}>
          <span className="drop">
            <b>도</b>
          </span>
        </div>
      )}
    </div>
  );
}
