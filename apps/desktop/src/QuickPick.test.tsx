// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import QuickPick, { type QuickPickProps } from './QuickPick.js';

const props = (): QuickPickProps => ({ label: 'Quick Open', placeholder: 'Find a file', query: '', onQueryChange: vi.fn(),
  items: [{ id: 'one', label: 'one.ts', detail: 'src/one.ts' }, { id: 'two', label: 'two.ts', shortcut: '⌘2' }], onChoose: vi.fn(), onClose: vi.fn() });
afterEach(cleanup);

describe('quick pick', () => {
  it('keeps focus in the combobox and selects using wrapped arrow navigation', () => {
    const handlers = props(); render(<QuickPick {...handlers}/>);
    const input = screen.getByRole('combobox', { name: 'Quick Open' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /two.ts/ })).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /two.ts/ }).id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onChoose).toHaveBeenCalledWith('two');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onChoose).toHaveBeenLastCalledWith('one');
  });
  it('resets the active option after query changes and supports mouse selection', () => {
    const handlers = props(); const { rerender } = render(<QuickPick {...handlers}/>);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'o' } });
    expect(handlers.onQueryChange).toHaveBeenCalledWith('o');
    rerender(<QuickPick {...handlers} query="o"/>);
    expect(screen.getByRole('option', { name: /one.ts/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('option', { name: /two.ts/ }));
    expect(handlers.onChoose).toHaveBeenCalledWith('two');
  });
  it('does not choose or close while composing, and closes on Escape afterward', () => {
    const handlers = props(); render(<QuickPick {...handlers}/>);
    const input = screen.getByRole('combobox');
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Escape' });
    expect(handlers.onChoose).not.toHaveBeenCalled(); expect(handlers.onClose).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(handlers.onChoose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
  it('handles empty results without a dangling active descendant', () => {
    const handlers = props(); render(<QuickPick {...handlers} items={[]}/>);
    const input = screen.getByRole('combobox');
    expect(screen.getByRole('status')).toHaveTextContent('No results.');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onChoose).not.toHaveBeenCalled();
  });
});
