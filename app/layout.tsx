import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "モーションコミック自動生成ツール",
  description: "漫画1ページ（統合画像）から、動くサンプル動画(mp4)を生成する編集ツール",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
