import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { MermaidDiagram } from "./MermaidDiagram";
import type { Components } from "react-markdown";

function isWikiLink(href: string): boolean {
  // External protocols (http:, https:, mailto:, ftp:, tel:, javascript:, etc.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  // Protocol-relative URLs
  if (href.startsWith('//')) return false;
  // Anchor links
  if (href.startsWith('#')) return false;
  // Relative paths with directories
  if (href.includes('/')) return false;
  // File extensions (e.g., .pdf, .png, .html) -- but not slugs with dots
  if (/\.\w{2,4}$/.test(href)) return false;
  // Anything remaining is treated as a wiki slug
  return true;
}

export function MarkdownRenderer({ content, lang }: { content: string; lang: string }) {
  const components: Components = {
    a({ href, children }) {
      if (!href) return <>{children}</>;

      if (isWikiLink(href)) {
        return <Link to={`/wiki/${lang}/${href}`}>{children}</Link>;
      }

      if (href.startsWith("#")) {
        return <a href={href}>{children}</a>;
      }

      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },

    code({ className, children }) {
      const match = /language-(\w+)/.exec(className || "");
      const codeLang = match ? match[1] : "";
      const codeStr = String(children).replace(/\n$/, "");

      if (codeLang === "mermaid") {
        return <MermaidDiagram chart={codeStr} />;
      }

      if (codeLang) {
        return (
          <pre>
            <code className={className}>{codeStr}</code>
          </pre>
        );
      }

      return <code className={className}>{children}</code>;
    },

    pre({ children }) {
      // If the child is already our custom code handler that returned a <pre> or MermaidDiagram,
      // pass it through without wrapping in another <pre>
      const child = children as React.ReactElement;
      if (child?.type === "pre" || child?.type === MermaidDiagram) {
        return <>{children}</>;
      }
      return <pre>{children}</pre>;
    },

    table({ children }) {
      return (
        <div className="wiki-table-wrapper">
          <table>{children}</table>
        </div>
      );
    },
  };

  return (
    <div className="wiki-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
