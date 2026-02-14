import { useEffect, useState, Component } from "react";
import { useParams, useNavigate } from "react-router";
import type { MetaFunction } from "react-router";
import { Nav } from "~/components/Nav";
import { Footer } from "~/components/Footer";
import { WikiSidebar } from "~/components/wiki/WikiSidebar";
import { MarkdownRenderer } from "~/components/wiki/MarkdownRenderer";
import { LanguageSwitch } from "~/components/wiki/LanguageSwitch";
import "~/styles/wiki.css";
import "~/styles/fonts.css";

const SUPPORTED_LANGS = ["en", "ar"] as const;
type SupportedLang = typeof SUPPORTED_LANGS[number];

function isSupportedLang(lang: string): lang is SupportedLang {
  return (SUPPORTED_LANGS as readonly string[]).includes(lang);
}

// Eagerly load sidebar (needed on every page)
const sidebarModules = import.meta.glob("../../../wiki/_Sidebar.md", { query: "?raw", eager: true });
const sidebarContent = Object.values(sidebarModules)[0] as string;

// Lazily load English wiki pages (exclude _Sidebar.md and _Footer.md)
const enModules = import.meta.glob(["../../../wiki/*.md", "!../../../wiki/_*.md"], { query: "?raw" }) as Record<string, () => Promise<string>>;

// Lazily load Arabic wiki pages
const arModules = import.meta.glob("../../../wiki/ar/*.md", { query: "?raw" }) as Record<string, () => Promise<string>>;

function buildSlugMap(modules: Record<string, () => Promise<string>>, prefix: string) {
  const map: Record<string, () => Promise<string>> = {};
  for (const [path, loader] of Object.entries(modules)) {
    const filename = path.replace(prefix, "").replace(".md", "");
    if (!filename.startsWith("_")) {
      map[filename] = loader;
    }
  }
  return map;
}

const enPages = buildSlugMap(enModules, "../../../wiki/");
const arPages = buildSlugMap(arModules, "../../../wiki/ar/");

export const meta: MetaFunction = () => [
  { title: "Developer Wiki - Zajel" },
  { name: "description", content: "Zajel developer documentation — architecture, protocols, security, and more" },
];

// Fonts are self-hosted via ~/styles/fonts.css (no external Google Fonts dependency)

class WikiErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Wiki content rendering error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="wiki-markdown">
          <h1>Rendering Error</h1>
          <p>This page could not be rendered. The content may be malformed.</p>
          <p>
            <a href="/wiki/en">Return to Wiki Home</a>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Wiki() {
  const params = useParams();
  const navigate = useNavigate();

  const lang = params.lang || "en";
  const slug = params.slug || "Home";
  const isArabic = lang === "ar";

  const [content, setContent] = useState<string | null>(null);
  const [isFallback, setIsFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pageError, setPageError] = useState<"not-found" | "load-error" | null>(null);

  // Redirect /wiki or invalid lang to /wiki/en
  useEffect(() => {
    if (!params.lang || !isSupportedLang(params.lang)) {
      navigate(`/wiki/en${slug !== "Home" ? `/${slug}` : ""}`, { replace: true });
    }
  }, [params.lang, navigate, slug]);

  // Load page content
  useEffect(() => {
    let cancelled = false;

    async function loadPage() {
      setLoading(true);
      setIsFallback(false);
      setPageError(null);

      const pages = isArabic ? arPages : enPages;
      let loader = pages[slug];
      let fallback = false;

      // Arabic fallback: if page doesn't exist in Arabic, load English version
      if (!loader && isArabic) {
        loader = enPages[slug];
        if (loader != null) fallback = true;
      }

      if (!loader) {
        if (!cancelled) {
          setContent(null);
          setPageError("not-found");
          setLoading(false);
        }
        return;
      }

      try {
        const raw = await loader();
        // Handle both default export and direct string
        const md = typeof raw === "string" ? raw : (raw as { default: string }).default;
        if (!cancelled) {
          setContent(md);
          setIsFallback(fallback);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setContent(null);
          setPageError("load-error");
          setIsFallback(false);
          setLoading(false);
        }
      }
    }

    loadPage();
    return () => { cancelled = true; };
  }, [lang, slug, isArabic]);

  // Close sidebar on navigation
  useEffect(() => {
    setSidebarOpen(false);
  }, [slug, lang]);

  if (!params.lang || !isSupportedLang(params.lang)) return null; // Will redirect

  return (
    <>
      <Nav />
      <div className="wiki-layout" dir={isArabic ? "rtl" : "ltr"} style={isArabic ? { fontFamily: "'Noto Sans Arabic', sans-serif" } : undefined}>
        <WikiSidebar
          sidebarMd={sidebarContent}
          lang={lang}
          currentSlug={slug}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="wiki-content">
          <div className="wiki-header-bar">
            <LanguageSwitch lang={lang} slug={slug} />
          </div>

          {isFallback && (
            <div className="wiki-fallback-notice">
              هذه الصفحة غير متوفرة بالعربية بعد. يتم عرض النسخة الإنجليزية.
              <br />
              <small>(This page is not yet available in Arabic. Showing English version.)</small>
            </div>
          )}

          {loading ? (
            <div className="wiki-loading">Loading...</div>
          ) : pageError === "not-found" ? (
            <div className="wiki-markdown">
              <h1>Page Not Found</h1>
              <p>The page <strong>{slug}</strong> does not exist.</p>
            </div>
          ) : pageError === "load-error" ? (
            <div className="wiki-markdown">
              <h1>Error</h1>
              <p>Failed to load <strong>{slug}</strong>.</p>
            </div>
          ) : (
            <WikiErrorBoundary>
              {content && <MarkdownRenderer content={content} lang={lang} />}
            </WikiErrorBoundary>
          )}
        </main>

        <button
          className="wiki-sidebar-toggle"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label="Toggle sidebar"
        >
          {sidebarOpen ? "\u2715" : "\u2630"}
        </button>
      </div>
      <Footer />
    </>
  );
}

export function ErrorBoundary() {
  return (
    <>
      <Nav />
      <div className="wiki-layout">
        <main className="wiki-content">
          <div className="wiki-markdown">
            <h1>Something went wrong</h1>
            <p>An unexpected error occurred. Please try again later.</p>
            <p>
              <a href="/wiki/en">Return to Wiki Home</a>
            </p>
          </div>
        </main>
      </div>
      <Footer />
    </>
  );
}
