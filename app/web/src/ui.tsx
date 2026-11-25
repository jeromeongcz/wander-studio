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
export const fmtBytes = (n: number) => (n <= 0 ? '0 KB' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

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

const ICONS: Record<string, string> = {
  expand: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M8 5v14M16 5v14',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5',
  rows: 'M3 5h18v5H3zM3 14h18v5H3z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  home: 'M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  video: 'M3 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3zM17 10l4-2v8l-4-2',
  image: 'M3 5h18v14H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 16l-5-5-8 8',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M20 6 9 17l-5-5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  sun: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16M15 4v16',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  spark: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
  rocket: 'M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2M9 15l-3-3 6-7c2-2 6-2.5 8-2.5 0 2-.5 6-2.5 8l-7 6zM15 9h.01',
};
export const Icon = ({ name, small }: { name: keyof typeof ICONS | string; small?: boolean }) => (
  <svg className={`icon${small ? ' icon-sm' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name] ?? ''} /></svg>
);
