import { useEffect, useRef, useState, useId } from "react";
import DOMPurify from "dompurify";

let mermaidInitialized = false;

export function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const reactId = useId();
  const mermaidId = `mermaid-${reactId.replace(/:/g, '')}`;

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default;

        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: "dark",
            themeVariables: {
              darkMode: true,
              background: "#1e293b",
              primaryColor: "#6366f1",
              primaryTextColor: "#f8fafc",
              primaryBorderColor: "#4f46e5",
              lineColor: "#94a3b8",
              secondaryColor: "#334155",
              tertiaryColor: "#0f172a",
            },
          });
          mermaidInitialized = true;
        }

        const { svg } = await mermaid.render(mermaidId, chart.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          });
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }

    render();
    return () => { cancelled = true; };
  }, [chart, mermaidId]);

  if (error) {
    return <pre className="wiki-mermaid-error">{chart}</pre>;
  }

  return <div ref={containerRef} className="wiki-mermaid" />;
}
