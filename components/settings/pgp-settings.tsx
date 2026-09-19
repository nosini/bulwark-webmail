"use client";

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ShieldCheck } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { createMailvelopeHost } from '@/components/pgp/mailvelope-host';
import { sanitizeDisplayName } from '@/lib/rfc5322-mailbox';
import { useIdentityStore } from '@/stores/identity-store';
import { useMailvelopeStore } from '@/stores/mailvelope-store';
import { toast } from '@/stores/toast-store';
import { SettingsSection } from './settings-section';

type EmbedState = 'loading' | 'ready' | 'unavailable';

/**
 * Key management for the Mailvelope extension. Everything inside the frame is
 * the extension's own UI: keys are generated, imported and stored there, and
 * nothing of them passes through Bulwark. Only shown while Mailvelope is
 * available, so it never renders for users without the extension.
 */
export function PgpSettings() {
  const t = useTranslations('settings.pgp');
  const api = useMailvelopeStore((s) => s.api);
  const keyring = useMailvelopeStore((s) => s.keyring);
  const version = useMailvelopeStore((s) => s.version);
  const identity = useIdentityStore((s) => s.identities[0]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [embed, setEmbed] = useState<EmbedState>('loading');

  // Prefill for the extension's key generation. Read through a ref: identities
  // often arrive after mount, and restarting the frame for that would throw
  // away whatever the user has already started.
  const prefillRef = useRef({ email: identity?.email, fullName: sanitizeDisplayName(identity?.name) });
  prefillRef.current = { email: identity?.email, fullName: sanitizeDisplayName(identity?.name) };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !api || !keyring) return;
    // Deprecated since Mailvelope 6.1 in favor of keyring.openSettings(), but
    // still shipped: embed it when present and fall back to the button when not.
    if (typeof api.createSettingsContainer !== 'function') {
      setEmbed('unavailable');
      return;
    }
    let cancelled = false;
    setEmbed('loading');
    const host = createMailvelopeHost(container);
    api
      .createSettingsContainer(host.selector, keyring, prefillRef.current)
      .then(() => {
        if (!cancelled) setEmbed('ready');
      })
      .catch(() => {
        if (!cancelled) setEmbed('unavailable');
      });
    return () => {
      cancelled = true;
      host.dispose();
    };
  }, [api, keyring]);

  const openSettings = async () => {
    try {
      await keyring?.openSettings();
    } catch {
      toast.error(t('open_settings_failed'));
    }
  };

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <p className="flex items-center gap-2 text-sm text-foreground">
        <ShieldCheck className="w-4 h-4 text-green-600 shrink-0" />
        {version ? t('status_connected', { version }) : t('status_connected_no_version')}
      </p>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t('keys_title')}</h4>
        <p className="text-sm text-muted-foreground">{t('keys_description')}</p>

        {embed === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('keys_loading')}
          </p>
        )}
        {embed === 'unavailable' && <p className="text-sm text-muted-foreground">{t('keys_embed_failed')}</p>}

        <div
          ref={containerRef}
          hidden={embed === 'unavailable'}
          className="w-full overflow-hidden rounded-md border border-border"
          style={{ height: 640 }}
          data-testid="pgp-settings-frame"
        />

        <Button variant="outline" size="sm" onClick={openSettings}>
          {t('open_settings')}
        </Button>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium text-foreground">{t('limits_title')}</h4>
        <p className="text-sm text-muted-foreground">{t('limits_body')}</p>
      </div>
    </SettingsSection>
  );
}
