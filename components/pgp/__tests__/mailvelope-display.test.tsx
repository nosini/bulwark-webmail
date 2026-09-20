import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MailvelopeDisplay } from '../mailvelope-display';
import type { PgpMessageSource } from '@/lib/mailvelope/detect';

const mv = vi.hoisted(() => ({ createDisplayContainer: vi.fn() }));

vi.mock('@/stores/mailvelope-store', () => {
  const state = { api: { createDisplayContainer: (...a: unknown[]) => mv.createDisplayContainer(...a) }, keyring: { identifier: 'k' } };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useMailvelopeStore: hook };
});

const ARMOR = ['-----BEGIN PGP MESSAGE-----', '', 'hQEMA1Vn7c1u8bVh', '=AbCd', '-----END PGP MESSAGE-----'].join('\n');
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

const mime: PgpMessageSource = {
  kind: 'pgp-mime',
  payloadBlobId: 'payload',
  payloadName: 'encrypted.asc',
  payloadType: 'application/octet-stream',
  hiddenPartIds: ['1', '2'],
};

beforeEach(() => {
  mv.createDisplayContainer.mockReset().mockResolvedValue({});
});

describe('MailvelopeDisplay', () => {
  it('opens an inline PGP message with the armored block, the keyring and the sender', async () => {
    render(
      <MailvelopeDisplay
        source={{ kind: 'inline', armored: ARMOR }}
        senderAddress="alice@example.com"
        fetchBlob={vi.fn()}
        onShowOriginal={vi.fn()}
      />,
    );
    await waitFor(() => expect(mv.createDisplayContainer).toHaveBeenCalledTimes(1));
    const [selector, armored, keyring, options] = mv.createDisplayContainer.mock.calls[0];
    expect(selector).toMatch(/^#mailvelope-host-\d+$/);
    expect(document.querySelector(selector)).not.toBeNull();
    expect(armored).toBe(ARMOR);
    expect(keyring).toEqual({ identifier: 'k' });
    expect(options).toEqual({ senderAddress: 'alice@example.com' });
    expect(await screen.findByText('display_note')).toBeInTheDocument();
  });

  it('fetches the PGP/MIME payload blob and passes Mailvelope only the armored ciphertext, never the MIME wrapper', async () => {
    const fetchBlob = vi.fn().mockResolvedValue(bytes(`\r\n${ARMOR.replace(/\n/g, '\r\n')}\r\n`));
    render(<MailvelopeDisplay source={mime} senderAddress="alice@example.com" fetchBlob={fetchBlob} onShowOriginal={vi.fn()} />);

    await waitFor(() => expect(mv.createDisplayContainer).toHaveBeenCalledTimes(1));
    expect(fetchBlob).toHaveBeenCalledWith('payload', 'encrypted.asc', 'application/octet-stream');
    expect(mv.createDisplayContainer.mock.calls[0][1]).toBe(ARMOR);
  });

  it('shows the failure state, and never calls Mailvelope, when the payload holds no armor', async () => {
    const fetchBlob = vi.fn().mockResolvedValue(bytes('not armor at all'));
    render(<MailvelopeDisplay source={mime} fetchBlob={fetchBlob} onShowOriginal={vi.fn()} />);
    expect(await screen.findByText('display_failed')).toBeInTheDocument();
    expect(mv.createDisplayContainer).not.toHaveBeenCalled();
  });

  it('stops waiting when the page CSP blocks the extension frame', async () => {
    // The container never loads and never errors, so without this the spinner
    // would run for as long as the message stayed open.
    const never = new Promise<never>(() => {});
    mv.createDisplayContainer.mockReturnValue(never);
    render(<MailvelopeDisplay source={{ kind: 'inline', armored: ARMOR }} fetchBlob={vi.fn()} onShowOriginal={vi.fn()} />);
    expect(await screen.findByText('display_loading')).toBeInTheDocument();

    fireEvent(document, Object.assign(new Event('securitypolicyviolation'), {
      effectiveDirective: 'frame-src',
      blockedURI: 'chrome-extension://kajibbejlbohfaggdiogboambcijhkke/decryptMessage.html',
    }));

    expect(await screen.findByText('display_failed')).toBeInTheDocument();
  });

  it('shows the failure state when the blob cannot be fetched', async () => {
    render(<MailvelopeDisplay source={mime} fetchBlob={vi.fn().mockRejectedValue(new Error('404'))} onShowOriginal={vi.fn()} />);
    expect(await screen.findByText('display_failed')).toBeInTheDocument();
  });

  it('shows the failure state when Mailvelope cannot parse the armor', async () => {
    mv.createDisplayContainer.mockResolvedValue({ error: Object.assign(new Error('bad'), { code: 'ARMOR_PARSE_ERROR' }) });
    render(<MailvelopeDisplay source={{ kind: 'inline', armored: ARMOR }} fetchBlob={vi.fn()} onShowOriginal={vi.fn()} />);
    expect(await screen.findByText('display_failed')).toBeInTheDocument();
  });

  it('leaves errors like a missing private key to Mailvelope’s own frame', async () => {
    mv.createDisplayContainer.mockResolvedValue({ error: Object.assign(new Error('no key'), { code: 'NO_KEY_FOUND' }) });
    render(<MailvelopeDisplay source={{ kind: 'inline', armored: ARMOR }} fetchBlob={vi.fn()} onShowOriginal={vi.fn()} />);
    expect(await screen.findByText('display_note')).toBeInTheDocument();
  });

  it('offers the original message', async () => {
    const onShowOriginal = vi.fn();
    render(<MailvelopeDisplay source={{ kind: 'inline', armored: ARMOR }} fetchBlob={vi.fn()} onShowOriginal={onShowOriginal} />);
    fireEvent.click(await screen.findByText('display_show_original'));
    expect(onShowOriginal).toHaveBeenCalledTimes(1);
  });

  it('removes its host element on unmount, so a late injection finds nothing', async () => {
    const view = render(<MailvelopeDisplay source={{ kind: 'inline', armored: ARMOR }} fetchBlob={vi.fn()} onShowOriginal={vi.fn()} />);
    await waitFor(() => expect(mv.createDisplayContainer).toHaveBeenCalled());
    const selector = mv.createDisplayContainer.mock.calls[0][0];
    expect(document.querySelector(selector)).not.toBeNull();
    view.unmount();
    expect(document.querySelector(selector)).toBeNull();
  });

  it('does not restart decryption when only the parent re-renders', async () => {
    const source: PgpMessageSource = { kind: 'inline', armored: ARMOR };
    const view = render(<MailvelopeDisplay source={source} fetchBlob={vi.fn()} onShowOriginal={vi.fn()} />);
    await waitFor(() => expect(mv.createDisplayContainer).toHaveBeenCalledTimes(1));
    view.rerender(<MailvelopeDisplay source={source} fetchBlob={vi.fn()} onShowOriginal={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(mv.createDisplayContainer).toHaveBeenCalledTimes(1);
  });
});
