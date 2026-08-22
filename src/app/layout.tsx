import type { Metadata, Viewport } from "next";
import "./globals.css";
import DevIssues from "@/components/DevIssues";

export const metadata: Metadata = {
  title: "푹신푹신 — 지하철 좌석 하차정보",
  description: "지하철 좌석 점유자의 하차 정보를 나누는 리워드 기반 서비스",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#245E9C",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>
        {children}
        {/* 개발 중에만 보이는 문제 알림 패널 (배포본에는 포함되지 않습니다) */}
        {process.env.NODE_ENV === "development" && <DevIssues />}
      </body>
    </html>
  );
}
