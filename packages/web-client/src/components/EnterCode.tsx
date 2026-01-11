import { useState, useRef, useCallback } from 'preact/hooks';

interface EnterCodeProps {
  onSubmit: (code: string) => void;
  disabled?: boolean;
}

export function EnterCode({ onSubmit, disabled }: EnterCodeProps) {
  const [chars, setChars] = useState(['', '', '', '', '', '']);
  const [announcement, setAnnouncement] = useState('');
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

      // Announce progress for screen readers
      const filledCount = newChars.filter(c => c).length;
      if (filledCount === 6) {
        setAnnouncement('Code complete. Press Connect button or Enter to connect.');
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
      } else if (e.key === 'ArrowLeft' && index > 0) {
        // Allow arrow key navigation between inputs
        e.preventDefault();
        inputRefs.current[index - 1]?.focus();
      } else if (e.key === 'ArrowRight' && index < 5) {
        e.preventDefault();
        inputRefs.current[index + 1]?.focus();
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

        // Announce paste for screen readers
        setAnnouncement(`Pasted code: ${pasted.split('').join(' ')}. ${pasted.length} of 6 characters.`);
      }
    },
    [chars]
  );

  const code = chars.join('');
  const isComplete = code.length === 6;
  const filledCount = chars.filter(c => c).length;

  const handleConnect = () => {
    if (isComplete && !disabled) {
      onSubmit(code);
    }
  };

  return (
    <section
      class="card"
      role="region"
      aria-labelledby="enter-code-heading"
    >
      <h2 id="enter-code-heading">Peer's Code</h2>

      {/* Screen reader instructions */}
      <p id="code-instructions" class="sr-only">
        Enter the 6-character code from your peer. Use arrow keys to navigate between fields.
        Characters will auto-advance to the next field.
      </p>

      <div
        class="code-input"
        onPaste={handlePaste}
        role="group"
        aria-labelledby="enter-code-heading"
        aria-describedby="code-instructions code-progress"
      >
        {chars.map((char, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el; }}
            type="text"
            inputMode="text"
            maxLength={1}
            value={char}
            onInput={(e) => handleInput(i, (e.target as HTMLInputElement).value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            disabled={disabled}
            aria-label={`Character ${i + 1} of 6`}
            aria-required="true"
            autoComplete="off"
            autoCapitalize="characters"
          />
        ))}
      </div>

      {/* Progress indicator for screen readers */}
      <div id="code-progress" class="sr-only" aria-live="polite">
        {filledCount} of 6 characters entered
      </div>

      {/* Live region for announcements */}
      <div aria-live="polite" aria-atomic="true" class="sr-only">
        {announcement}
      </div>

      <button
        class="btn btn-primary"
        onClick={handleConnect}
        disabled={!isComplete || disabled}
        aria-disabled={!isComplete || disabled}
        aria-busy={disabled}
        aria-describedby={!isComplete ? 'connect-hint' : undefined}
      >
        {disabled ? 'Connecting...' : 'Connect'}
      </button>

      {/* Hint for incomplete code */}
      {!isComplete && (
        <span id="connect-hint" class="sr-only">
          Enter all 6 characters to enable the Connect button
        </span>
      )}
    </section>
  );
}
