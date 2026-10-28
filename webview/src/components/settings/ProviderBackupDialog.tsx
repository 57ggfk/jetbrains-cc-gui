import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent, sendToJava } from '../../utils/bridge';
import styles from './ProviderBackupDialog.module.less';

export type ProviderBackupMode = 'import' | 'export';
type Action = ProviderBackupMode | 'select';
interface Selection { selection: string; fileName: string; encrypted: boolean }
interface Result extends Partial<Selection> {
  requestId: string;
  engine: string;
  status: string;
  imported?: number;
  skipped?: number;
  providerIndex?: number;
  field?: string;
}
interface BackupError { code: string; providerIndex?: number; field?: string }
interface Props {
  engine: 'claude' | 'codex';
  mode: ProviderBackupMode;
  onClose: () => void;
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

const KEY = 'settings.provider.backup.';
const ERROR_CODES = new Set([
  'invalidFile', 'wrongEngine', 'tooLarge', 'empty', 'passwordRequired', 'wrongPassword',
  'failed', 'busy', 'selectFile', 'passwordShort',
]);
const ERROR_FIELDS = new Map([
  ['name', 'name'], ['remark', 'remark'], ['websiteUrl', 'websiteUrl'], ['category', 'category'],
  ['settingsConfig', 'settingsConfig'], ['configToml', 'config.toml'], ['authJson', 'auth.json'],
  ['customModels', 'customModels'], ['messageEnvVars', 'messageEnvVars'], ['mcpEnvVars', 'mcpEnvVars'],
]);
let nextRequestId = 0;

export default function ProviderBackupDialog({ engine, mode, onClose, addToast }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [allowPlaintext, setAllowPlaintext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BackupError | null>(null);
  const pending = useRef<{ id: string; action: Action; timeout: ReturnType<typeof setTimeout> } | null>(null);
  const title = t(KEY + (mode === 'export' ? 'exportTitle' : 'importTitle'), {
    engine: engine === 'claude' ? 'Claude Code' : 'Codex',
  });

  useEffect(() => {
    const receive = (event: Event) => {
      const result = (event as CustomEvent<Result>).detail;
      const request = pending.current;
      if (!request || result?.requestId !== request.id || result.engine !== engine) return;
      clearTimeout(request.timeout);
      pending.current = null;
      setBusy(false);
      if (result.status === 'cancelled') return;
      if (result.status !== 'success') {
        const exporting = request.action === 'export';
        const code = ERROR_CODES.has(result.status) ? result.status : 'failed';
        const providerIndex = exporting && typeof result.providerIndex === 'number'
          && Number.isInteger(result.providerIndex) && result.providerIndex > 0 && result.providerIndex <= 2000
          ? result.providerIndex : undefined;
        setError({
          code: exporting && code === 'invalidFile' ? 'exportInvalidConfig' : code,
          providerIndex,
          field: exporting && typeof result.field === 'string' ? ERROR_FIELDS.get(result.field) : undefined,
        });
        return;
      }
      if (request.action === 'select') {
        if (typeof result.selection !== 'string' || typeof result.fileName !== 'string'
          || typeof result.encrypted !== 'boolean') {
          setError({ code: 'invalidFile' });
          return;
        }
        setSelection(result as Selection);
        setPassword('');
      } else {
        if (request.action === 'import') {
          sendToJava(engine === 'claude' ? 'get_providers' : 'get_codex_providers');
        }
        addToast(t(KEY + (request.action === 'import' ? 'importSuccess' : 'exportSuccess'), {
          imported: result.imported ?? 0,
          skipped: result.skipped ?? 0,
        }), 'success');
        onClose();
      }
    };
    window.addEventListener('provider-backup-result', receive);
    return () => window.removeEventListener('provider-backup-result', receive);
  }, [engine, addToast, onClose, t]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => {
      if (pending.current) clearTimeout(pending.current.timeout);
      pending.current = null;
      previousFocus?.focus();
    };
  }, []);

  function request(action: Action) {
    if (pending.current) return;
    setError(null);
    const id = `backup-${Date.now()}-${++nextRequestId}`;
    const timeout = setTimeout(() => {
      if (pending.current?.id !== id) return;
      pending.current = null;
      setBusy(false);
      setError({ code: 'timeout' });
    }, 120_000);
    pending.current = { id, action, timeout };
    setBusy(true);
    const sent = sendBridgeEvent('provider_backup', JSON.stringify({
      requestId: id, engine, action, dialogTitle: title,
      ...(action !== 'select' ? { password, selection: selection?.selection } : {}),
    }));
    if (!sent) {
      clearTimeout(timeout);
      pending.current = null;
      setBusy(false);
      setError({ code: 'failed' });
    }
  }

  function submit() {
    if (pending.current) return;
    if (mode === 'import') {
      if (!selection) return setError({ code: 'selectFile' });
      if (selection.encrypted && !password) return setError({ code: 'passwordRequired' });
    } else {
      if (password && password.length < 8) return setError({ code: 'passwordShort' });
      if (password && password !== confirmation) return setError({ code: 'passwordMismatch' });
      if (!password && !allowPlaintext) return setError({ code: 'plaintextWarning' });
    }
    request(mode);
  }

  return createPortal(
    <div className={styles.overlay}>
      <form ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-busy={busy} onSubmit={event => { event.preventDefault(); submit(); }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!pending.current) onClose();
          }
          if (event.key === 'Tab') {
            const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
            if (!controls?.length) return;
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <h3 id={titleId}>{title}</h3>
        <p>{t(KEY + 'scope')}</p>
        {mode === 'import' && <>
          <button type="button" disabled={busy} onClick={() => request('select')}>{t(KEY + 'selectFile')}</button>
          {selection && <p className={styles.fileName}>{selection.fileName}</p>}
          <p>{t(KEY + 'mergeHint')}</p>
        </>}
        {(mode === 'export' || selection?.encrypted) && <label>
          {t(KEY + (mode === 'export' ? 'passwordOptional' : 'passwordRequired'))}
          <input type="password" autoComplete="off" maxLength={1024} value={password} disabled={busy}
            onChange={event => setPassword(event.target.value)} />
        </label>}
        {mode === 'export' && <>
          {password ? <label>
            {t(KEY + 'confirmPassword')}
            <input type="password" autoComplete="off" maxLength={1024} value={confirmation} disabled={busy}
              onChange={event => setConfirmation(event.target.value)} />
          </label> : <label className={styles.warning}>
            <input type="checkbox" checked={allowPlaintext} disabled={busy}
              onChange={event => setAllowPlaintext(event.target.checked)} />
            {t(KEY + 'plaintextWarning')}
          </label>}
          <p>{t(KEY + 'passwordHint')}</p>
        </>}
        {error && <p role="alert" className={styles.error}>
          {t(KEY + error.code)}
          {error.providerIndex !== undefined ? <> {t(KEY + 'errorProvider', { index: error.providerIndex })}</> : null}
          {error.field ? <> {t(KEY + 'errorField', { field: error.field })}</> : null}
        </p>}
        {busy && <p role="status">{t(KEY + 'working')}</p>}
        <div className={styles.footer}>
          <button type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" disabled={busy} className={styles.primary}>
            {t(KEY + mode)}
          </button>
        </div>
      </form>
    </div>, document.body,
  );
}
