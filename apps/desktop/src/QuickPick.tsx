import { useEffect, useId, useRef, useState } from 'react';
import './QuickPick.css';

export interface QuickPickItem { id: string; label: string; detail?: string; shortcut?: string }
export interface QuickPickProps {
  label: string;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  items: QuickPickItem[];
  onChoose: (id: string) => void;
  onClose: () => void;
}

export default function QuickPick({ label, placeholder, query, onQueryChange, items, onChoose, onClose }: QuickPickProps) {
  const id = useId();
  const [active, setActive] = useState(0);
  const [activeQuery, setActiveQuery] = useState(query);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  if (activeQuery !== query) { setActiveQuery(query); setActive(0); }
  const index = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { document.getElementById(`${id}-option-${index}`)?.scrollIntoView?.({ block: 'nearest' }); }, [id, index]);
  return <div className="quick-pick">
    <input ref={input} role="combobox" aria-label={label} placeholder={placeholder} value={query}
      aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`}
      aria-activedescendant={items.length ? `${id}-option-${index}` : undefined}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onChange={event => onQueryChange(event.target.value)}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (items.length) setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (items[index]) onChoose(items[index].id);
        }
      }}/>
    <div className="quick-pick-list" id={`${id}-list`} role="listbox" aria-label={label}>
      {items.map((item, itemIndex) => <button type="button" role="option" tabIndex={-1} id={`${id}-option-${itemIndex}`} key={item.id}
        aria-selected={index === itemIndex} className="quick-pick-option" onMouseEnter={() => setActive(itemIndex)}
        onMouseDown={event => event.preventDefault()} onClick={() => onChoose(item.id)}>
        <span className="quick-pick-copy"><span>{item.label}</span>{item.detail && <small>{item.detail}</small>}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>)}
    </div>
    {!items.length && <p className="quick-pick-empty" role="status">No results.</p>}
  </div>;
}
