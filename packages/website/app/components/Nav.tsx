import { Link, useLocation } from "react-router";

export function Nav() {
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <nav className="nav" aria-label="Main navigation">
      <div className="nav-logo">
        <Link to="/">Zajel</Link>
      </div>
      <div className="nav-links">
        <a href="/#features">Features</a>
        <a href="/#download">Download</a>
        <Link to="/guide" aria-current={isActive("/guide") ? "page" : undefined}>User Guide</Link>
        <Link to="/wiki/en" aria-current={isActive("/wiki") ? "page" : undefined}>Wiki</Link>
        <a href="https://github.com/Hamza-Labs-Core/zajel" target="_blank" rel="noopener noreferrer" aria-label="GitHub (opens in new tab)">
          GitHub
        </a>
        <a href="https://hamzalabs.dev" target="_blank" rel="noopener noreferrer" aria-label="HamzaLabs (opens in new tab)">
          HamzaLabs
        </a>
      </div>
    </nav>
  );
}
