// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import SearchPanel, { type SearchResult } from './SearchPanel.js';
import { api } from './api.js';

vi.mock('./api.js', () => ({ api: vi.fn() }));
const project = { id: 'p', name: 'Project', root: '/tmp/project' };
const result = (path: string): SearchResult => ({ matches: [{ path, line: 12, column: 4, preview: 'literal [text]' }], truncated: false });
const submit = (query: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search repository' }), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
};
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('repository search', () => {
  it('passes literal queries and options, and opens a result at its exact location', async () => {
    vi.mocked(api).mockResolvedValue(result('src/file.ts'));
    const open = vi.fn(); render(<SearchPanel project={project} onOpen={open}/>);
    fireEvent.click(screen.getByLabelText('Match case'));
    fireEvent.click(screen.getByLabelText('Match whole word'));
    submit('[text]');
    fireEvent.click(await screen.findByRole('button', { name: /src\/file.ts:12/ }));
    expect(api).toHaveBeenCalledWith('searchWorkspace', { projectId: 'p', query: '[text]', caseSensitive: true, wholeWord: true });
    expect(open).toHaveBeenCalledWith('src/file.ts', 12, 4);
    expect(screen.getByText(/Unsaved changes are excluded/)).toBeInTheDocument();
  });
  it('ignores a stale query response and a response from a previous project', async () => {
    const pending: Array<(value: SearchResult) => void> = [];
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { pending.push(resolve as (value: SearchResult) => void); }));
    const { rerender } = render(<SearchPanel project={project} onOpen={vi.fn()}/>);
    submit('old'); submit('new');
    await act(async () => pending[1](result('new.ts')));
    await act(async () => pending[0](result('old.ts')));
    expect(screen.queryByText('old.ts:12')).not.toBeInTheDocument();
    expect(screen.getByText('new.ts:12')).toBeInTheDocument();
    submit('pending');
    rerender(<SearchPanel project={{ ...project, id: 'other' }} onOpen={vi.fn()}/>);
    await act(async () => pending[2](result('previous-project.ts')));
    expect(screen.queryByText('previous-project.ts:12')).not.toBeInTheDocument();
    expect(screen.queryByText('new.ts:12')).not.toBeInTheDocument();
  });
  it('invalidates a response when the query changes before another search', async () => {
    let finish!: (value: SearchResult) => void;
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    render(<SearchPanel project={project} onOpen={vi.fn()}/>);
    submit('old');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } });
    await act(async () => finish(result('old.ts')));
    expect(screen.queryByText('old.ts:12')).not.toBeInTheDocument();
  });
  it('shows loading, empty, failure, and search limit feedback', async () => {
    vi.mocked(api).mockResolvedValueOnce({ matches: [], truncated: true }).mockRejectedValueOnce(new Error('Cannot read workspace'));
    render(<SearchPanel project={project} onOpen={vi.fn()}/>);
    submit('x'.repeat(201));
    expect(screen.getByRole('textbox')).toHaveValue('x'.repeat(200));
    expect(screen.getByText('200-character limit reached.')).toBeInTheDocument();
    expect(screen.getByText('Searching…')).toBeInTheDocument();
    expect(await screen.findByText('No matches found.')).toBeInTheDocument();
    expect(screen.getByText(/Results may be incomplete/)).toBeInTheDocument();
    submit('retry');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot read workspace');
  });
  it('requires an open project and supports requested focus', () => {
    const { rerender } = render(<SearchPanel onOpen={vi.fn()}/>);
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    rerender(<SearchPanel project={project} onOpen={vi.fn()} focusVersion={1}/>);
    expect(screen.getByRole('textbox')).toHaveFocus();
  });
});
