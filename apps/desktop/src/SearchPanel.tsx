import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type { Project } from './model.js';
import './SearchPanel.css';

export interface SearchMatch { path: string; line: number; column: number; preview: string }
export interface SearchResult { matches: SearchMatch[]; truncated: boolean }
export interface SearchPanelProps {
  project?: Project;
  onOpen: (path: string, line: number, column: number) => void;
  focusVersion?: number;
}

export default function SearchPanel({ project, onOpen, focusVersion }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [result, setResult] = useState<SearchResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const invalidate = () => { generation.current++; setResult(undefined); setLoading(false); setError(''); };
  useEffect(() => {
    invalidate();
    return () => { generation.current++; };
  }, [project?.id]);
  useEffect(() => { if (focusVersion !== undefined) input.current?.focus(); }, [focusVersion]);
  const search = async () => {
    if (!project || !query.trim()) return;
    const version = ++generation.current;
    setLoading(true); setError(''); setResult(undefined);
    try {
      const found = await api<SearchResult>('searchWorkspace', { projectId: project.id, query, caseSensitive, wholeWord });
      if (version === generation.current) setResult(found);
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  return <section className="search-panel" aria-label="Repository search">
    <form onSubmit={event => { event.preventDefault(); void search(); }}>
      <input ref={input} aria-label="Search repository" placeholder="Search repository" value={query} maxLength={200} disabled={!project}
        onChange={event => { invalidate(); setQuery(event.target.value.slice(0, 200)); }}/>
      <div className="search-options">
        <label><input type="checkbox" checked={caseSensitive} onChange={event => { invalidate(); setCaseSensitive(event.target.checked); }}/>Match case</label>
        <label><input type="checkbox" checked={wholeWord} onChange={event => { invalidate(); setWholeWord(event.target.checked); }}/>Match whole word</label>
      </div>
      <button type="submit" className="primary block" disabled={!project || !query.trim()}>Search</button>
    </form>
    <p className="search-hint">Search saved files. Unsaved changes are excluded. Literal text, up to 200 characters.</p>
    {query.length === 200 && <p className="search-notice" role="status">200-character limit reached.</p>}
    {!project && <p className="search-hint">Open a project to search its files.</p>}
    <div className="search-results" aria-live="polite" aria-busy={loading}>
      {loading && <p className="search-hint" role="status">Searching…</p>}
      {error && <p className="search-error" role="alert">{error}</p>}
      {result && <>
        <p className="search-hint">{result.matches.length} {result.matches.length === 1 ? 'result' : 'results'}</p>
        {result.truncated && <p className="search-notice">Search limit reached. Results may be incomplete; narrow your search.</p>}
        {!result.matches.length && <p className="search-hint">No matches found.</p>}
        {result.matches.map((match, index) => <button type="button" className="search-result" key={`${match.path}:${match.line}:${match.column}:${index}`}
          onClick={() => onOpen(match.path, match.line, match.column)}>
          <span className="search-location">{match.path}:{match.line}</span>
          <span className="search-preview">{match.preview}</span>
        </button>)}
      </>}
    </div>
  </section>;
}
