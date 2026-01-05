import { Link } from "react-router";

export function Nav() {
  return (
    <nav className="nav">
      <div className="nav-logo">
        <Link to="/">Zajel</Link>
      </div>
      <div className="nav-links">
        <a href="/#features">Features</a>
        <a href="/#download">Download</a>
        <Link to="/guide">User Guide</Link>
        <a href="https://github.com/Hamza-Labs-Core/zajel" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        <a href="https://hamzalabs.dev" target="_blank" rel="noopener noreferrer">
          HamzaLabs
        </a>
      </div>
    </nav>
  );
}
