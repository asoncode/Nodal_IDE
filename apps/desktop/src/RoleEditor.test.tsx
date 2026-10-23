// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RoleEditor, { RoleLibrary, RoleRunDetails } from './RoleEditor.js';
import { api } from './api.js';
import type { Role } from '../../../packages/shared/src/index.js';

vi.mock('./api.js', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const role: Role = { id: 'ui', title: 'UI engineer', expertise: 'Build accessible interfaces.', knowledge: ['docs/ui.md'], owns: ['apps/web/**'], produces: [{ name: 'UI contract', path: 'contracts/ui.json', required: true }], consumes: [], skills: ['Test interactions.'] };

describe('functional role editor', () => {
  it('validates the complete role before applying a step snapshot', () => {
    const onChange = vi.fn();
    render(<RoleEditor value={role} onChange={onChange}/>);
    fireEvent.change(screen.getByLabelText('Role title'), { target: { value: 'Interface engineer' } });
    fireEvent.change(screen.getByLabelText('Owned paths (one per line)'), { target: { value: 'apps/ui/**\n\npackages/design/**' } });
    fireEvent.change(screen.getByLabelText('Consumes JSON'), { target: { value: '[{"name":"API","path":"contracts/api.json","required":true}]' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply role to step' }));
    expect(onChange).toHaveBeenCalledWith({ ...role, title: 'Interface engineer', owns: ['apps/ui/**', 'packages/design/**'], consumes: [{ name: 'API', path: 'contracts/api.json', required: true }] });
    expect(role.title).toBe('UI engineer');
  });

  it('rejects malformed handoffs and unsafe paths without applying', () => {
    const onChange = vi.fn();
    render(<RoleEditor value={role} onChange={onChange}/>);
    fireEvent.change(screen.getByLabelText('Produces JSON'), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply role to step' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Produces JSON'), { target: { value: '[]' } });
    fireEvent.change(screen.getByLabelText('Knowledge paths (one per line)'), { target: { value: '../private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply role to step' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('loads, copies, updates, and deletes library roles without mutating the applied snapshot', async () => {
    vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}) => {
      if (method === 'listRoles') return [structuredClone(role)] as T;
      if (method === 'saveRole') return params.role as T;
      if (method === 'deleteRole') return { deleted: true } as T;
      throw new Error(method);
    });
    const onApply = vi.fn();
    render(<RoleLibrary projectId="p" role={role} onApply={onApply}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Load roles' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply UI engineer' }));
    const applied = onApply.mock.calls[0][0] as Role;
    expect(applied).toEqual(role);
    expect(applied).not.toBe(role);
    fireEvent.click(screen.getByRole('button', { name: 'Edit UI engineer' }));
    fireEvent.change(screen.getByLabelText('Role title'), { target: { value: 'Library revision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save library role' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('saveRole', { projectId: 'p', role: { ...role, title: 'Library revision' } }));
    expect(applied.title).toBe('UI engineer');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save library role' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Delete UI engineer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply UI engineer' })).toBeNull());
    expect(api).toHaveBeenCalledWith('deleteRole', { projectId: 'p', roleId: 'ui' });
    expect(applied).toEqual(role);
  });
});


it('shows unavailable usage explicitly and keeps recorded context inspectable', () => {
  render(<RoleRunDetails events={[
    { eventId: 'context', kind: 'role.context', payload: { knowledgePaths: ['docs/ui.md'], layers: [{ name: 'expertise', characters: 33 }] } },
    { eventId: 'usage', kind: 'role.usage', payload: { inputTokens: null, outputTokens: 42, costUsd: null } },
  ]}/>);
  expect(screen.getByText('Context supplied')).toBeTruthy();
  expect(screen.getByText(/Input tokens: unavailable/)).toBeTruthy();
  expect(screen.getByText(/Output tokens: 42/)).toBeTruthy();
  expect(screen.getByText(/Cost: unavailable/)).toBeTruthy();
  expect(screen.getByText(/docs\/ui.md/)).toBeTruthy();
});

it('ignores a late role library response after switching projects', async () => {
  let resolveOld!: (roles: Role[]) => void;
  const oldResponse = new Promise<Role[]>(resolve => { resolveOld = resolve; });
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'listRoles') return (params.projectId === 'old' ? oldResponse : []) as T;
    throw new Error(method);
  });
  const view = render(<RoleLibrary projectId="old"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Load roles' }));
  view.rerender(<RoleLibrary projectId="new"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Load roles' }));
  await screen.findByText(/No saved roles/);
  await act(async () => { resolveOld([role]); });
  await waitFor(() => expect(screen.queryByText('UI engineer')).toBeNull());
});
