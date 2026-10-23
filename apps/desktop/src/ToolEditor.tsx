import { useEffect, useState } from 'react';
import { ToolConfigSchema, type ToolConfig } from '../../../packages/shared/src/index.js';

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
export const TOOL_LABELS: Record<ToolConfig['tool'], string> = {
  search: 'Search code', symbols: 'Find symbols', read: 'Read files', list: 'List files', git: 'Git history', 'test-impact': 'Find affected tests', validate: 'Validate file', 'step-output': 'Read earlier step output',
};
export function defaultToolConfig(tool: ToolConfig['tool'], earlier: { id: string }[] = []): ToolConfig {
  switch (tool) {
    case 'search': return { tool, query: 'TODO', regex: false, caseSensitive: false, paths: [], maxResults: 100 };
    case 'symbols': return { tool, paths: [], maxResults: 100 };
    case 'read': return { tool, paths: ['README.md'], maxBytes: 64 * 1024 };
    case 'list': return { tool, paths: [], maxResults: 500 };
    case 'git': return { tool, mode: 'log', paths: [], maxResults: 50 };
    case 'test-impact': return { tool, paths: [], maxResults: 100 };
    case 'validate': return { tool, path: 'contracts/api.json', required: true };
    case 'step-output': return { tool, nodeId: earlier[0]?.id ?? '' };
  }
}

/** Edits a draft and publishes only configurations that pass the schema, so the graph never holds an invalid tool. */
export default function ToolEditor({ value, onChange, earlier = [] }: { value: ToolConfig; onChange: (config: ToolConfig) => void; earlier?: { id: string; label: string }[] }) {
  const [draft, setDraft] = useState<Record<string, unknown>>(value);
  const [schemaText, setSchemaText] = useState(value.tool === 'validate' && value.schema ? JSON.stringify(value.schema, null, 2) : '');
  const [error, setError] = useState('');
  useEffect(() => { setDraft(value); setSchemaText(value.tool === 'validate' && value.schema ? JSON.stringify(value.schema, null, 2) : ''); setError(''); }, [value]);
  const update = (next: Record<string, unknown>) => {
    setDraft(next);
    const parsed = ToolConfigSchema.safeParse(next);
    if (parsed.success) { setError(''); onChange(parsed.data); }
    else setError(parsed.error.issues.map(issue => `${issue.path.join('.') || 'tool'}: ${issue.message}`).join('; '));
  };
  const set = (key: string, field: unknown) => update({ ...draft, [key]: field });
  const tool = draft.tool as ToolConfig['tool'];
  const text = (key: string) => typeof draft[key] === 'string' ? draft[key] as string : '';
  const paths = Array.isArray(draft.paths) ? (draft.paths as string[]).join('\n') : '';
  return <div className="tool-editor">
    <label className="field"><span>Tool</span><select aria-label="Tool" value={tool} onChange={event => { const next = defaultToolConfig(event.target.value as ToolConfig['tool'], earlier); setSchemaText(''); update(next); }}>
      {(Object.keys(TOOL_LABELS) as ToolConfig['tool'][]).map(item => <option key={item} value={item}>{TOOL_LABELS[item]}</option>)}
    </select></label>
    {tool === 'search' && <>
      <label className="field"><span>Search for</span><input aria-label="Search for" value={text('query')} onChange={event => set('query', event.target.value)}/></label>
      <label className="check-field"><input type="checkbox" checked={draft.regex === true} onChange={event => set('regex', event.target.checked)}/>Extended regular expression</label>
      <label className="check-field"><input type="checkbox" checked={draft.caseSensitive === true} onChange={event => set('caseSensitive', event.target.checked)}/>Match case</label>
    </>}
    {tool === 'symbols' && <label className="field"><span>Symbol name (optional)</span><input aria-label="Symbol name" value={text('name')} placeholder="All definitions in scope" onChange={event => update(event.target.value ? { ...draft, name: event.target.value } : Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'name')))}/></label>}
    {tool === 'git' && <>
      <label className="field"><span>Mode</span><select aria-label="Git mode" value={text('mode')} onChange={event => set('mode', event.target.value)}><option value="log">Log</option><option value="diff">Diff</option><option value="blame">Blame</option></select></label>
      {draft.mode === 'diff' && <label className="field"><span>Compare with (optional)</span><input aria-label="Compare with" value={text('ref')} placeholder="Run's starting commit" onChange={event => update(event.target.value ? { ...draft, ref: event.target.value } : Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'ref')))}/></label>}
    </>}
    {tool === 'validate' && <>
      <label className="field"><span>File</span><input aria-label="File to validate" value={text('path')} onChange={event => set('path', event.target.value)}/></label>
      <label className="check-field"><input type="checkbox" checked={draft.required === true} onChange={event => set('required', event.target.checked)}/>Fail the step when invalid</label>
      <label className="field"><span>JSON schema (optional)</span><textarea className="config-json" rows={5} value={schemaText} onChange={event => {
        setSchemaText(event.target.value);
        if (!event.target.value.trim()) { update(Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'schema'))); return; }
        try { update({ ...draft, schema: JSON.parse(event.target.value) }); } catch { setError('Schema must be valid JSON.'); }
      }}/></label>
    </>}
    {tool === 'step-output' && <label className="field"><span>Earlier step</span><select aria-label="Earlier step" value={text('nodeId')} onChange={event => set('nodeId', event.target.value)}><option value="">Choose a step</option>{earlier.map(step => <option key={step.id} value={step.id}>{step.label}</option>)}</select></label>}
    {tool !== 'validate' && tool !== 'step-output' && <label className="field"><span>{tool === 'read' ? 'Files (one path or glob per line)' : tool === 'test-impact' ? 'Changed files (blank: since the run started)' : 'Limit to paths (one per line, blank for all)'}</span><textarea aria-label="Paths" rows={3} value={paths} onChange={event => set('paths', lines(event.target.value))}/></label>}
    <p className="field-help">Reads the step's commit, never your working files. Runs without a model or an approval prompt, and repeats exactly for the same commit.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
