"use client";

// ============================================================
// 개발용 "무슨 문제가 났는지" 알려주는 패널
//
// Next.js가 좌하단에 띄우는 빨간 Issues 버튼은 개발자용이라
// 눌러도 코드만 잔뜩 나옵니다. 이 파일은 같은 오류를 잡아서
// "무슨 일인지 / 왜 그런지 / 어떻게 할지"를 한국말로 보여줍니다.
//
// 개발할 때만 켜집니다(npm run dev). 배포본에는 나오지 않습니다.
// ============================================================

import { useEffect, useState } from "react";

type Level = "error" | "warn";

type Issue = {
  key: string; // 같은 문제를 묶는 기준 (원문)
  level: Level;
  raw: string; // 원문 (개발자용)
  count: number; // 같은 문제가 몇 번 났는지
  first: string; // 처음 난 시각 HH:MM:SS
  last: string; // 마지막으로 난 시각
};

// ------------------------------------------------------------
// 원문 오류 → 사람이 읽는 설명
// 위에서부터 순서대로 맞춰보고, 처음 걸리는 것을 씁니다.
// ------------------------------------------------------------
type Explain = { title: string; cause: string; todo: string; mild?: boolean };

const RULES: { test: RegExp; ex: Explain }[] = [
  {
    test: /hydrat|does not match|didn't match|did not match/i,
    ex: {
      title: "서버가 그린 화면과 브라우저가 그린 화면이 서로 달라요",
      cause:
        "시계처럼 매 순간 달라지는 값을 화면에 그리면 납니다. 서버가 미리 만들어 보낸 글자와, 브라우저가 다시 만든 글자가 달라서 React가 알려주는 것입니다.",
      todo: "화면 자체는 대개 멀쩡합니다. 시각을 보여주는 부분을 '브라우저에서만 그리기'로 바꾸면 사라집니다.",
      mild: true,
    },
  },
  {
    test: /Maximum update depth|Too many re-?renders/i,
    ex: {
      title: "화면이 스스로를 끝없이 다시 그리고 있어요",
      cause:
        "그릴 때마다 값을 바꾸는 코드가 있어서 무한 반복에 빠졌습니다. 가만히 둬도 이슈 숫자가 계속 올라가고 앱이 느려집니다.",
      todo: "가장 급한 문제입니다. 지금 열려 있던 화면 이름을 알려주세요.",
    },
  },
  {
    test: /unique ["'`]?key|Each child in a list/i,
    ex: {
      title: "목록 항목에 붙이는 이름표(key)가 빠졌어요",
      cause:
        "역 목록·좌석처럼 여러 개를 줄줄이 그릴 때, React는 항목마다 겹치지 않는 이름표를 원합니다. 그게 없으면 경고합니다.",
      todo: "화면 동작에는 지장이 없습니다. 급하지 않은 정리 항목입니다.",
      mild: true,
    },
  },
  {
    test: /cannot appear as a descendant|validateDOMNesting/i,
    ex: {
      title: "화면 조각을 잘못 겹쳐 넣었어요",
      cause:
        "예를 들어 글자 문단 안에 상자를 넣는 것처럼, HTML이 허용하지 않는 조합으로 화면을 짰습니다.",
      todo: "보통은 화면이 정상으로 보입니다. 나중에 정리하면 됩니다.",
      mild: true,
    },
  },
  {
    test: /트래픽|traffic|LIMITED_NUMBER|limit ?exceed|ERROR-33[0-9]|초과/i,
    ex: {
      title: "오늘 쓸 수 있는 지하철 API 호출 횟수를 다 썼어요",
      cause:
        "서울열린데이터광장·ODsay는 하루에 부를 수 있는 횟수가 정해져 있습니다. 실시간 열차 화면은 20초마다 자동으로 부르기 때문에, 켜두는 시간이 길수록 빨리 소진됩니다.",
      todo: "보통 다음 날 0시에 초기화됩니다. 테스트할 때 실시간 화면을 오래 켜두지 마세요.",
    },
  },
  {
    test: /UND_ERR|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|timeout/i,
    ex: {
      title: "바깥 지하철 서버가 제때 답하지 않았어요",
      cause:
        "서울시·ODsay 서버를 한꺼번에 여러 번 부르면 연결이 막힙니다. 인터넷이 잠깐 불안정할 때도 납니다.",
      todo: "잠시 후 다시 시도하면 대부분 풀립니다. 자주 나면 자동 갱신 주기(20초)를 늘리는 게 좋습니다.",
    },
  },
  {
    test: /Failed to fetch|NetworkError|ERR_CONNECTION|ERR_NETWORK|Load failed|fetch failed/i,
    ex: {
      title: "우리 서버를 부르다 실패했어요",
      cause:
        "개발 서버(npm run dev)가 잠깐 멈췄거나 다시 켜지는 중일 때 가장 흔합니다. 코드를 저장하면 서버가 잠시 재시작되는데, 그 찰나에 화면이 서버를 부르면 이 오류가 납니다.",
      todo: "새로고침하면 대부분 사라집니다. 계속 나면 터미널에서 개발 서버가 살아 있는지 확인하세요.",
    },
  },
  {
    test: /INFO-200|데이터가 없|no ?data|결과가 없/i,
    ex: {
      title: "그 역·노선에는 지금 보여줄 데이터가 없어요",
      cause:
        "막차가 끊긴 시간이거나, 서울교통공사가 운영하지 않는 노선(인천1호선 등)이라 실시간 정보 자체가 제공되지 않는 경우입니다.",
      todo: "고장이 아닙니다. 다른 노선·다른 시간대로 확인해 보세요.",
      mild: true,
    },
  },
  {
    test: /\b5\d\d\b/,
    ex: {
      title: "서버 쪽에서 오류가 났어요",
      cause:
        "우리 서버 코드가 처리 도중에 멈췄습니다. 터미널(npm run dev 창)에 자세한 내용이 찍혀 있습니다.",
      todo: "아래 '원문 보기'의 주소를 알려주시면 어느 기능인지 바로 찾을 수 있습니다.",
    },
  },
  {
    test: /\b404\b/,
    ex: {
      title: "찾는 주소가 없어요",
      cause: "화면이 부른 주소가 서버에 없습니다. 주소를 잘못 적었거나 파일이 빠진 경우입니다.",
      todo: "아래 '원문 보기'의 주소를 알려주세요.",
    },
  },
  {
    test: /is not a function|undefined is not|Cannot read propert|of undefined|of null/i,
    ex: {
      title: "있어야 할 값이 비어 있어요",
      cause:
        "데이터가 아직 도착하지 않았는데 화면이 먼저 그 값을 쓰려고 했습니다. 응답이 예상과 다른 모양으로 왔을 때도 납니다.",
      todo: "어느 화면에서 났는지 알려주시면 그 부분에 '값이 없을 때' 처리를 넣겠습니다.",
    },
  },
  {
    test: /^Warning:|React does not recognize|Invalid DOM property|non-boolean attribute|Received NaN/i,
    ex: {
      title: "React가 코드 스타일을 지적했어요",
      cause: "화면을 그리는 방식이 권장과 조금 달라서 알려주는 것입니다. 사용자에게 보이는 문제는 아닙니다.",
      todo: "무시해도 됩니다. 나중에 정리 항목입니다.",
      mild: true,
    },
  },
];

const FALLBACK: Explain = {
  title: "예상하지 못한 문제가 났어요",
  cause: "아래 '원문 보기'에 개발자용 원래 메시지가 들어 있습니다.",
  todo: "그 원문을 그대로 복사해서 알려주시면 원인을 찾겠습니다.",
};

function explain(raw: string): Explain {
  for (const r of RULES) if (r.test.test(raw)) return r.ex;
  return FALLBACK;
}

function clock(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 화면에 보여줄 길이로 자르고, 줄바꿈을 정리합니다.
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 600);
}

export default function DevIssues() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState<string | null>(null);

  useEffect(() => {
    // 같은 문제는 하나로 묶고 횟수만 올립니다.
    // (가만히 둬도 숫자가 오르는 경우, 무엇이 반복되는지 한눈에 보입니다.)
    const add = (level: Level, raw: string) => {
      const text = tidy(raw);
      if (!text) return;
      setIssues((prev) => {
        const i = prev.findIndex((x) => x.key === text);
        const now = clock();
        if (i >= 0) {
          const next = [...prev];
          next[i] = { ...next[i], count: next[i].count + 1, last: now, level };
          next.unshift(next.splice(i, 1)[0]); // 방금 난 것을 맨 위로
          return next;
        }
        return [{ key: text, level, raw: text, count: 1, first: now, last: now }, ...prev].slice(0, 60);
      });
    };

    const origError = console.error;
    const origWarn = console.warn;

    console.error = function (...args: unknown[]) {
      add("error", args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
      return origError.apply(console, args as []);
    };
    console.warn = function (...args: unknown[]) {
      add("warn", args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
      return origWarn.apply(console, args as []);
    };

    const onErr = (e: ErrorEvent) => add("error", e.message || String(e.error));
    const onRej = (e: PromiseRejectionEvent) =>
      add("error", e.reason instanceof Error ? e.reason.message : String(e.reason));
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);

    // 서버를 부르다 실패하거나 오류 코드가 돌아온 것도 잡습니다.
    const origFetch = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const target = args[0];
      const url = String(
        typeof target === "string" ? target : target instanceof Request ? target.url : target
      );
      // Next.js 자체 통신(핫 리로드 등)은 우리 문제가 아니라 제외합니다.
      const mine = !/\/_next\/|__nextjs|\/\.well-known\//.test(url);
      try {
        const res = await origFetch.apply(window, args);
        if (mine && !res.ok) add("error", `통신 실패 ${res.status} — ${url}`);
        return res;
      } catch (err) {
        if (mine) add("error", `통신 실패 (연결 안 됨) — ${url} — ${String(err)}`);
        throw err;
      }
    };

    return () => {
      console.error = origError;
      console.warn = origWarn;
      window.fetch = origFetch;
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  const total = issues.reduce((n, x) => n + x.count, 0);
  const hasReal = issues.some((x) => !explain(x.raw).mild);

  return (
    <>
      <style>{CSS}</style>

      <button
        className={`di-fab${total ? (hasReal ? " bad" : " mild") : " ok"}`}
        onClick={() => setOpen((v) => !v)}
        title="개발 중에만 보이는 문제 알림"
      >
        {total ? `문제 ${total}` : "문제 없음"}
      </button>

      {open && (
        <div className="di-panel">
          <div className="di-head">
            <b>무슨 문제가 났나요?</b>
            <span className="di-note">개발할 때만 보입니다</span>
            <button className="di-clear" onClick={() => setIssues([])}>
              비우기
            </button>
            <button className="di-x" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>

          <div className="di-body">
            {!issues.length && <p className="di-empty">아직 잡힌 문제가 없습니다.</p>}

            {issues.map((it) => {
              const ex = explain(it.raw);
              return (
                <div key={it.key} className={`di-card${ex.mild ? " mild" : ""}`}>
                  <div className="di-title">
                    <span className="di-dot" />
                    {ex.title}
                    {it.count > 1 && <em className="di-cnt">{it.count}번</em>}
                  </div>

                  <p className="di-line">
                    <b>왜 그럴까요</b>
                    {ex.cause}
                  </p>
                  <p className="di-line">
                    <b>어떻게 할까요</b>
                    {ex.todo}
                  </p>

                  <div className="di-foot">
                    <span>
                      처음 {it.first}
                      {it.count > 1 && ` · 마지막 ${it.last}`}
                    </span>
                    <button onClick={() => setShowRaw(showRaw === it.key ? null : it.key)}>
                      {showRaw === it.key ? "원문 접기" : "원문 보기"}
                    </button>
                  </div>

                  {showRaw === it.key && <pre className="di-raw">{it.raw}</pre>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

const CSS = `
/* 앱의 ◎ 버튼(오른쪽 아래)과 겹치지 않도록 한 칸 위에 둡니다. */
.di-fab{position:fixed;right:12px;bottom:132px;z-index:9998;border:1.5px solid var(--line-2);
  border-radius:999px;background:var(--surface);color:var(--muted);font-family:var(--sans);
  font-size:12px;font-weight:750;padding:9px 14px;cursor:pointer;box-shadow:var(--shadow)}
.di-fab.bad{background:#DA4A3B;border-color:#DA4A3B;color:#fff}
.di-fab.mild{background:var(--warn-weak);border-color:var(--warn);color:var(--warn)}
.di-fab.ok{opacity:.5}
.di-panel{position:fixed;right:10px;left:10px;bottom:174px;z-index:9999;max-width:460px;margin-left:auto;
  max-height:62dvh;display:flex;flex-direction:column;background:var(--surface);
  border:1.5px solid var(--line-2);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
.di-head{display:flex;align-items:center;gap:8px;padding:12px 12px 10px;border-bottom:1px solid var(--line)}
.di-head b{font-size:14px;font-weight:800;color:var(--ink)}
.di-note{font-size:11px;color:var(--faint);font-weight:600}
.di-clear,.di-x{border:none;background:none;font-family:inherit;font-size:12px;
  font-weight:700;color:var(--muted);cursor:pointer;padding:4px 6px}
.di-clear{margin-left:auto}
.di-x{font-size:13px}
.di-body{overflow-y:auto;padding:10px 12px 14px;display:flex;flex-direction:column;gap:10px}
.di-empty{margin:14px 0;text-align:center;font-size:12.5px;color:var(--faint);font-weight:600}
.di-card{border:1.5px solid var(--line);border-radius:12px;background:var(--surface-2);padding:11px 12px}
.di-title{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:800;color:var(--ink);line-height:1.45}
.di-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#DA4A3B}
.di-card.mild .di-dot{background:var(--warn)}
.di-cnt{flex:none;margin-left:auto;font-style:normal;font-size:11px;font-weight:750;color:var(--muted);
  background:var(--inset);border-radius:6px;padding:2px 6px}
.di-line{margin:8px 0 0;font-size:12.5px;line-height:1.6;color:var(--muted);font-weight:550}
.di-line b{display:block;font-size:11px;font-weight:750;color:var(--faint);margin-bottom:1px}
.di-foot{display:flex;align-items:center;gap:8px;margin-top:9px;font-size:11px;color:var(--faint);font-weight:600}
.di-foot button{margin-left:auto;border:1px solid var(--line-2);border-radius:7px;background:var(--surface);
  font-family:inherit;font-size:11px;font-weight:700;color:var(--muted);padding:4px 8px;cursor:pointer}
.di-raw{margin:9px 0 0;padding:9px 10px;background:var(--inset);border-radius:8px;
  font-family:var(--mono);font-size:10.5px;line-height:1.55;color:var(--muted);
  white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}
`;
