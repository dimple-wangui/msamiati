import "./globals.css";

export const metadata = {
  title: "Msamiati — Swahili flashcards",
  description: "Learn Swahili with flashcards that adapt to your memory.",
};

export const viewport = { width: "device-width", initialScale: 1, themeColor: "#0f766e" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
