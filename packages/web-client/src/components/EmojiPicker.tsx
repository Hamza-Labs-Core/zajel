import { useState, useRef, useEffect } from 'preact/hooks';
import { EMOJI_CATEGORIES } from '../lib/emoji-filter';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const [activeCategory, setActiveCategory] = useState(0);
  const [search, setSearch] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus search on open
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Filter emojis by search
  const filteredCategories = search.trim()
    ? EMOJI_CATEGORIES.map((cat) => ({
        ...cat,
        emojis: cat.emojis.filter(() => {
          // Simple: show all emojis from all categories when searching
          // The search is by category name match
          return cat.name.toLowerCase().includes(search.toLowerCase());
        }),
      })).filter((cat) => cat.emojis.length > 0)
    : EMOJI_CATEGORIES;

  return (
    <div ref={pickerRef} class="emoji-picker" role="dialog" aria-label="Emoji picker">
      {/* Search */}
      <div class="emoji-picker-search">
        <input
          ref={searchRef}
          type="text"
          placeholder="Search category..."
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          aria-label="Search emojis"
        />
      </div>

      {/* Category tabs */}
      {!search && (
        <div class="emoji-picker-tabs" role="tablist">
          {EMOJI_CATEGORIES.map((cat, i) => (
            <button
              key={cat.name}
              role="tab"
              aria-selected={i === activeCategory}
              class={`emoji-tab ${i === activeCategory ? 'active' : ''}`}
              onClick={() => setActiveCategory(i)}
              title={cat.name}
            >
              {cat.icon}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid */}
      <div class="emoji-picker-grid" role="grid" aria-label="Emojis">
        {(search ? filteredCategories : [filteredCategories[activeCategory]]).map((cat) => (
          <div key={cat.name}>
            {search && (
              <div class="emoji-category-label">{cat.name}</div>
            )}
            <div class="emoji-grid-row">
              {cat.emojis.map((emoji) => (
                <button
                  key={emoji}
                  class="emoji-btn"
                  onClick={() => onSelect(emoji)}
                  title={emoji}
                  role="gridcell"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
        {search && filteredCategories.length === 0 && (
          <div class="emoji-no-results">No results</div>
        )}
      </div>
    </div>
  );
}
