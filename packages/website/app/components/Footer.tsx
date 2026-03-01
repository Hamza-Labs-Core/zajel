import { Link } from "react-router";

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-content">
        <div className="footer-links">
          <a href="https://github.com/Hamza-Labs-Core/zajel" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a
            href="https://github.com/Hamza-Labs-Core/zajel/blob/main/packages/app/PRIVACY.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            Privacy Policy
          </a>
          <Link to="/guide">User Guide</Link>
          <Link to="/wiki/en">Wiki</Link>
          <a href="https://hamzalabs.dev" target="_blank" rel="noopener noreferrer">
            HamzaLabs
          </a>
        </div>
        <p className="footer-copy">
          Made with ❤️ by{" "}
          <a href="https://hamzalabs.dev" target="_blank" rel="noopener noreferrer">
            HamzaLabs
          </a>
          <br />
          <small>Open source under MIT License</small>
        </p>
      </div>
    </footer>
  );
}
