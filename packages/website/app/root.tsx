import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { LinksFunction } from "react-router";

import "./styles/global.css";

export const links: LinksFunction = () => [
  { rel: "icon", type: "image/png", href: "/favicon.png" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function HydrateFallback() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "#0f172a",
        color: "#f8fafc",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <img
          src="/images/app-icon.png"
          alt="Zajel"
          width={64}
          height={64}
          style={{ borderRadius: 12, marginBottom: 16 }}
        />
        <p style={{ color: "#94a3b8" }}>Loading...</p>
      </div>
    </div>
  );
}
