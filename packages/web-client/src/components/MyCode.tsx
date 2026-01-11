import { useState, useCallback } from 'preact/hooks';

interface MyCodeProps {
  code: string;
}

export function MyCode({ code }: MyCodeProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const chars = code.split('');
  // Create a spaced version for screen readers (e.g., "A B C 1 2 3")
  const spacedCode = chars.join(' ');

  return (
    <section
      class="card"
      role="region"
      aria-labelledby="my-code-heading"
    >
      <h2 id="my-code-heading">Your Code</h2>

      {/* Visual code display - hidden from screen readers */}
      <div
        class="code-display"
        role="img"
        aria-label={`Your connection code is ${spacedCode}`}
      >
        {chars.map((char, i) => (
          <div key={i} class="char" aria-hidden="true">
            {char}
          </div>
        ))}
      </div>

      {/* Screen reader accessible code */}
      <span class="sr-only">
        Your code is {code}. Share this code with your peer to connect.
      </span>

      {/* Copy button with feedback */}
      <button
        class="copy-btn"
        onClick={handleCopy}
        aria-label={copied ? 'Code copied to clipboard' : 'Copy code to clipboard'}
        aria-live="polite"
      >
        {copied ? 'Copied!' : 'Copy Code'}
      </button>

      {/* Live region to announce copy success */}
      <div aria-live="polite" aria-atomic="true" class="sr-only">
        {copied && 'Code copied to clipboard'}
      </div>
    </section>
  );
}
