"use client";

import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, Lock, PenLine, ShieldCheck } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RecipientKeyStatus } from '@/lib/mailvelope/recipients';

export type PgpComposeMode = 'off' | 'encrypt' | 'encrypt-sign';

interface PgpComposeToggleProps {
  mode: PgpComposeMode;
  disabled?: boolean;
  onToggleEncrypt: () => void;
  onToggleSign: () => void;
}

/** Composer toolbar buttons. Rendered only when Mailvelope is available. */
export function PgpComposeToggle({ mode, disabled, onToggleEncrypt, onToggleSign }: PgpComposeToggleProps) {
  const t = useTranslations('pgp');
  const on = mode !== 'off';
  const activeStyle = 'bg-green-600 text-white hover:bg-green-600 hover:text-white dark:bg-green-600 dark:hover:bg-green-600';
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleEncrypt}
        disabled={disabled}
        className={cn('h-9 w-9', on && activeStyle)}
        title={on ? t('encrypt_on') : t('encrypt_off')}
        aria-label={on ? t('encrypt_on') : t('encrypt_off')}
        aria-pressed={on}
        data-testid="composer-pgp-toggle"
      >
        <Lock className="w-4 h-4" />
      </Button>
      {on && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSign}
          disabled={disabled}
          className={cn('h-9 w-9', mode === 'encrypt-sign' && activeStyle)}
          title={mode === 'encrypt-sign' ? t('sign_on') : t('sign_off')}
          aria-label={mode === 'encrypt-sign' ? t('sign_on') : t('sign_off')}
          aria-pressed={mode === 'encrypt-sign'}
          data-testid="composer-pgp-sign-toggle"
        >
          <PenLine className="w-4 h-4" />
        </Button>
      )}
    </>
  );
}

interface PgpComposeBannerProps {
  signing: boolean;
  /** The extension went away (update or disabled): the encrypted editor is gone. */
  disconnected?: boolean;
  statuses: RecipientKeyStatus[];
  failed: string[];
  checking: boolean;
  onImport: (status: RecipientKeyStatus) => void;
  onRefresh: () => void;
  onManageKeys: () => void;
}

/**
 * What is and is not protected, and which recipients can actually be
 * encrypted to. A recipient without a key blocks sending.
 */
export function PgpComposeBanner({ signing, disconnected, statuses, failed, checking, onImport, onRefresh, onManageKeys }: PgpComposeBannerProps) {
  const t = useTranslations('pgp');
  const missing = statuses.filter((s) => s.state === 'missing');
  return (
    <div
      className="mx-4 my-2 rounded-md border border-green-600/40 bg-green-600/5 px-3 py-2 text-sm space-y-1.5"
      data-testid="composer-pgp-banner"
      role="region"
      aria-label={t('banner_title')}
    >
      <div className="flex items-center gap-2 font-medium text-foreground">
        <ShieldCheck className="w-4 h-4 text-green-600 shrink-0" />
        <span>{signing ? t('banner_title_signed') : t('banner_title')}</span>
      </div>
      {disconnected && (
        <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {t('error_disconnected')}
        </p>
      )}
      <ul className="list-disc ps-6 text-xs text-muted-foreground space-y-0.5">
        <li>{t('banner_cleartext_notice')}</li>
        <li>{t('banner_drafts_notice')}</li>
        <li>{t('banner_attachments_notice')}</li>
      </ul>

      {(statuses.length > 0 || failed.length > 0 || checking) && (
        <ul className="space-y-1 pt-1" aria-label={t('recipients_label')}>
          {statuses.map((status) => (
            <li key={status.address} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="font-mono text-foreground break-all">{status.address}</span>
              {status.state === 'ready' && <span className="text-green-700 dark:text-green-400">{t('recipient_ready')}</span>}
              {status.state === 'importable' && (
                <>
                  <span className="text-amber-700 dark:text-amber-400">{t('recipient_importable')}</span>
                  <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => onImport(status)}>
                    {t('import_key')}
                  </Button>
                </>
              )}
              {status.state === 'missing' && (
                <span className="flex items-center gap-1 text-destructive">
                  <AlertTriangle className="w-3 h-3" />
                  {t('recipient_missing')}
                </span>
              )}
            </li>
          ))}
          {failed.map((address) => (
            <li key={address} className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="w-3 h-3" />
              <span className="font-mono break-all">{address}</span>
              <span>{t('recipient_lookup_failed')}</span>
            </li>
          ))}
          {checking && (
            <li className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t('recipients_checking')}
            </li>
          )}
        </ul>
      )}

      {(missing.length > 0 || failed.length > 0) && (
        <p className="text-xs text-destructive">{t('send_blocked_hint')}</p>
      )}

      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onManageKeys}>
          {t('manage_keys')}
        </Button>
        {(statuses.length > 0 || failed.length > 0) && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onRefresh}>
            {t('check_again')}
          </Button>
        )}
      </div>
    </div>
  );
}
