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

  return (
    <div class="card">
      <h2>Your Code</h2>
      <div class="code-display">
        {chars.map((char, i) => (
          <div key={i} class="char">
            {char}
          </div>
        ))}
      </div>
      <button class="copy-btn" onClick={handleCopy}>
        {copied ? 'Copied!' : 'Copy Code'}
      </button>
    </div>
  );
}
