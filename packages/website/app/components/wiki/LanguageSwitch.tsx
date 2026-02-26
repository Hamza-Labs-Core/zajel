import { Link } from "react-router";

export function LanguageSwitch({ lang, slug }: { lang: string; slug: string }) {
  const enPath = slug === "Home" ? "/wiki/en" : `/wiki/en/${slug}`;
  const arPath = slug === "Home" ? "/wiki/ar" : `/wiki/ar/${slug}`;

  return (
    <div className="wiki-lang-switch">
      <Link to={enPath} className={`wiki-lang-btn${lang === "en" ? " active" : ""}`}>
        EN
      </Link>
      <Link to={arPath} className={`wiki-lang-btn${lang === "ar" ? " active" : ""}`}>
        عربي
      </Link>
    </div>
  );
}
