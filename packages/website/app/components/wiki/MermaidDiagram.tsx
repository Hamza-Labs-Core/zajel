import { useEffect, useRef, useState } from "react";

let mermaidInitialized = false;
let idCounter = 0;

export function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const idRef = useRef(`mermaid-${++idCounter}`);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default;

        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
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

        const { svg } = await mermaid.render(idRef.current, chart.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }

    render();
    return () => { cancelled = true; };
  }, [chart]);

  if (error) {
    return <pre className="wiki-mermaid-error">{chart}</pre>;
  }

  return <div ref={containerRef} className="wiki-mermaid" />;
}
