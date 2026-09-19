import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MailvelopeEditor } from '../mailvelope-editor';

const mv = vi.hoisted(() => ({ createEditorContainer: vi.fn() }));

vi.mock('@/stores/mailvelope-store', () => {
  const state = { api: { createEditorContainer: (...a: unknown[]) => mv.createEditorContainer(...a) }, keyring: { identifier: 'k' } };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useMailvelopeStore: hook };
});

beforeEach(() => {
  mv.createEditorContainer.mockReset().mockResolvedValue({ encrypt: vi.fn() });
});

describe('MailvelopeEditor', () => {
  it('starts with the text carried in when encryption was switched on', async () => {
    render(<MailvelopeEditor signMsg={false} initialText="draft text" onEditor={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(mv.createEditorContainer).toHaveBeenCalledTimes(1));
    const [, , options] = mv.createEditorContainer.mock.calls[0];
    expect(options).toMatchObject({ signMsg: false, predefinedText: 'draft text' });
  });

  it('restarts empty when signing is toggled and the text is cleared', async () => {
    // toggleSign clears initialText and flips signMsg in one update. The editor
    // used to read initialText from mount time, so it re-inserted the carried-in
    // text on restart -- contradicting the dialog that says it is discarded.
    const onEditor = vi.fn();
    const { rerender } = render(
      <MailvelopeEditor signMsg={false} initialText="draft text" onEditor={onEditor} onError={vi.fn()} />,
    );
    await waitFor(() => expect(mv.createEditorContainer).toHaveBeenCalledTimes(1));

    rerender(<MailvelopeEditor signMsg initialText="" onEditor={onEditor} onError={vi.fn()} />);
    await waitFor(() => expect(mv.createEditorContainer).toHaveBeenCalledTimes(2));

    const [, , options] = mv.createEditorContainer.mock.calls[1];
    expect(options).toEqual({ signMsg: true });
    expect(options).not.toHaveProperty('predefinedText');
    // The old handle is dropped before the new editor arrives.
    expect(onEditor).toHaveBeenCalledWith(null);
  });

  it('does not restart when only the text changes', async () => {
    const { rerender } = render(
      <MailvelopeEditor signMsg={false} initialText="one" onEditor={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() => expect(mv.createEditorContainer).toHaveBeenCalledTimes(1));

    rerender(<MailvelopeEditor signMsg={false} initialText="two" onEditor={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(mv.createEditorContainer).toHaveBeenCalledTimes(1));
  });
});
