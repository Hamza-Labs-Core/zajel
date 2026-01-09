import { useState, useRef, useCallback } from 'preact/hooks';

interface EnterCodeProps {
  onSubmit: (code: string) => void;
  disabled?: boolean;
}

export function EnterCode({ onSubmit, disabled }: EnterCodeProps) {
  const [chars, setChars] = useState(['', '', '', '', '', '']);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleInput = useCallback(
    (index: number, value: string) => {
      // Only allow alphanumeric
      const char = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-1);

      const newChars = [...chars];
      newChars[index] = char;
      setChars(newChars);

      // Auto-advance to next input
      if (char && index < 5) {
        inputRefs.current[index + 1]?.focus();
      }
    },
    [chars]
  );

  const handleKeyDown = useCallback(
    (index: number, e: KeyboardEvent) => {
      if (e.key === 'Backspace' && !chars[index] && index > 0) {
        // Move back on backspace if current is empty
        inputRefs.current[index - 1]?.focus();
      } else if (e.key === 'Enter') {
        const code = chars.join('');
        if (code.length === 6 && !disabled) {
          onSubmit(code);
        }
      }
    },
    [chars, disabled, onSubmit]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      e.preventDefault();
      const pasted = e.clipboardData
        ?.getData('text')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 6);

      if (pasted) {
        const newChars = [...chars];
        for (let i = 0; i < 6; i++) {
          newChars[i] = pasted[i] || '';
        }
        setChars(newChars);

        // Focus last filled or first empty
        const focusIndex = Math.min(pasted.length, 5);
        inputRefs.current[focusIndex]?.focus();
      }
    },
    [chars]
  );

  const code = chars.join('');
  const isComplete = code.length === 6;

  const handleConnect = () => {
    if (isComplete && !disabled) {
      onSubmit(code);
    }
  };

  return (
    <div class="card">
      <h2>Peer's Code</h2>
      <div class="code-input" onPaste={handlePaste}>
        {chars.map((char, i) => (
          <input
            key={i}
            ref={(el) => (inputRefs.current[i] = el)}
            type="text"
            maxLength={1}
            value={char}
            onInput={(e) => handleInput(i, (e.target as HTMLInputElement).value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            disabled={disabled}
          />
        ))}
      </div>
      <button
        class="btn btn-primary"
        onClick={handleConnect}
        disabled={!isComplete || disabled}
      >
        Connect
      </button>
    </div>
  );
}
