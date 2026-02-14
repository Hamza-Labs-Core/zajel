import { Link } from "react-router";

interface SidebarSection {
  title: string;
  links: { label: string; slug: string }[];
}

function parseSidebar(markdown: string): { homeLabel: string; sections: SidebarSection[] } {
  const lines = markdown.split("\n");
  let homeLabel = "Home";
  const sections: SidebarSection[] = [];
  let currentSection: SidebarSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Home link: **[Home](Home)**
    const homeMatch = trimmed.match(/^\*\*\[(.+?)\]\(Home\)\*\*$/);
    if (homeMatch) {
      homeLabel = homeMatch[1];
      continue;
    }

    // Section title: **Section Name**
    const sectionMatch = trimmed.match(/^\*\*(.+?)\*\*$/);
    if (sectionMatch) {
      currentSection = { title: sectionMatch[1], links: [] };
      sections.push(currentSection);
      continue;
    }

    // Link: - [Label](Slug)
    const linkMatch = trimmed.match(/^-\s*\[(.+?)\]\((.+?)\)$/);
    if (linkMatch && currentSection) {
      currentSection.links.push({ label: linkMatch[1], slug: linkMatch[2] });
    }
  }

  return { homeLabel, sections };
}

interface WikiSidebarProps {
  sidebarMd: string;
  lang: string;
  currentSlug: string;
  open: boolean;
  onClose: () => void;
}

export function WikiSidebar({ sidebarMd, lang, currentSlug, open, onClose }: WikiSidebarProps) {
  const { homeLabel, sections } = parseSidebar(sidebarMd);

  return (
    <>
      <div
        className={`wiki-sidebar-overlay${open ? " open" : ""}`}
        onClick={onClose}
      />
      <aside className={`wiki-sidebar${open ? " open" : ""}`}>
        <Link
          to={`/wiki/${lang}`}
          className={`wiki-sidebar-home${currentSlug === "Home" ? " active" : ""}`}
          onClick={onClose}
        >
          {homeLabel}
        </Link>
        <hr className="wiki-sidebar-divider" />
        {sections.map((section) => (
          <div key={section.title} className="wiki-sidebar-section">
            <div className="wiki-sidebar-section-title">{section.title}</div>
            {section.links.map((link) => (
              <Link
                key={link.slug}
                to={`/wiki/${lang}/${link.slug}`}
                className={`wiki-sidebar-link${currentSlug === link.slug ? " active" : ""}`}
                onClick={onClose}
              >
                {link.label}
              </Link>
            ))}
          </div>
        ))}
      </aside>
    </>
  );
}
