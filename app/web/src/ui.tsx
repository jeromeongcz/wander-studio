import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from './api';
import { STATE_LABEL } from './types';
import type { State } from './types';

// ---- toasts ----
interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'warn';
  text: string;
  list?: string[];
}
const ToastCtx = createContext<{ push: (kind: Toast['kind'], text: string, list?: string[]) => void; fail: (e: unknown) => void }>({ push: () => {}, fail: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string, list?: string[]) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, kind, text, list }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'ok' ? 3500 : 12000);
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        const d = Array.isArray(e.details) ? (e.details as unknown[]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : undefined;
        push('error', e.message, d);
      } else push('error', (e as Error)?.message ?? String(e));
    },
    [push],
  );
  return (
    <ToastCtx.Provider value={{ push, fail }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <div>{t.text}</div>
            {t.list && (
              <ul>
                {t.list.slice(0, 8).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
            <button className="x" aria-label="Dismiss" onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- primitives ----
export const StateBadge = ({ state }: { state: State }) => <span className={`badge st-${state}`}>{STATE_LABEL[state]}</span>;
export const Pill = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) => <span className={`pill pill-${tone}`}>{children}</span>;

export function Btn({ children, onClick, kind = 'default', disabled, busy, title, type = 'button', small }: { children: ReactNode; onClick?: () => void | Promise<void>; kind?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean; busy?: boolean; title?: string; type?: 'button' | 'submit'; small?: boolean }) {
  const [running, setRunning] = useState(false);
  const { fail } = useToast();
  const isBusy = busy || running;
  return (
    <button
      type={type}
      title={title}
      className={`btn btn-${kind}${small ? ' btn-sm' : ''}`}
      disabled={disabled || isBusy}
      onClick={async () => {
        if (!onClick) return;
        setRunning(true);
        try {
          await onClick();
        } catch (e) {
          fail(e);
        } finally {
          setRunning(false);
        }
      }}
    >
      {isBusy && <span className="spin" aria-hidden />}
      {children}
    </button>
  );
}

export const Card = ({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`card ${className}`}>
    {(title || actions) && (
      <header className="card-h">
        <h3>{title}</h3>
        <div className="row gap">{actions}</div>
      </header>
    )}
    {children}
  </section>
);

export const Field = ({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) => (
  <label className={`field${wide ? ' wide' : ''}`}>
    <span className="field-l">{label}</span>
    {children}
    {hint && <span className="hint">{hint}</span>}
  </label>
);

export const Loading = ({ what = 'Loading' }: { what?: string }) => (
  <div className="loading">
    <span className="spin" /> {what}…
  </div>
);
export const ErrorBox = ({ error, retry }: { error: Error; retry?: () => void }) => (
  <div className="errbox">
    <strong>Something went wrong.</strong> {error.message}
    {retry && (
      <Btn small onClick={retry}>
        Try again
      </Btn>
    )}
  </div>
);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h3>{title}</h3>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-b">{children}</div>
      </div>
    </div>
  );
}

export function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const { push } = useToast();
  return (
    <Btn
      small
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        push('ok', 'Copied to clipboard');
      }}
    >
      {label}
    </Btn>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} className={value === i.id ? 'on' : ''} onClick={() => onChange(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export const fmtSec = (s: number) => `${s.toFixed(1)}s`;
export const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Pick a local file and hand it back. */
export function FilePick({ accept, onFile, label = 'Choose file' }: { accept: string; onFile: (f: File) => void | Promise<void>; label?: string }) {
  return (
    <label className="btn btn-default filepick">
      {label}
      <input
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onFile(f);
        }}
      />
    </label>
  );
}
