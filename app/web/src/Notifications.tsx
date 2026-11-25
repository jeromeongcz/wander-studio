import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useAsync, useInterval } from './hooks';
import { Icon } from './ui';
import { partOfKind } from './pipeline';

interface Note { id: string; kind: string; tone: 'warn' | 'bad' | 'good'; title: string; detail: string; at: string; project_id?: string; artifact_kind?: string }

const KEY = 'wander-read-notifications';
const loadRead = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]')); } catch { return new Set(); } };
const saveRead = (s: Set<string>) => { try { localStorage.setItem(KEY, JSON.stringify([...s].slice(-300))); } catch { /* storage unavailable: they just show as unread again */ } };
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const link = (n: Note) => (n.kind === 'research' ? '#/research' : n.project_id ? `#/p/${n.project_id}/${n.artifact_kind ? partOfKind(n.artifact_kind) : 'overview'}` : '#/');

/** A bell that lists what needs the person right now. Everything is derived from current state; "read" is remembered in this browser only. */
export function Notifications() {
  const list = useAsync(() => api.get<Note[]>('/notifications'), []);
  useInterval(list.reload, 15000);
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Set<string>>(loadRead);
  const box = useRef<HTMLDivElement>(null);
  const notes = list.data ?? [];
  const unread = notes.filter((n) => !read.has(n.id));
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const markAll = () => { const s = new Set([...read, ...notes.map((n) => n.id)]); setRead(s); saveRead(s); };
  const markOne = (id: string) => { const s = new Set(read); s.add(id); setRead(s); saveRead(s); };
  return (
    <div className="notif" ref={box}>
      <button className="icon-btn" aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ''}`} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) list.reload(); }}>
        <Icon name="bell" />
        {unread.length > 0 && <span className="notif-dot">{unread.length > 9 ? '9+' : unread.length}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="row gap notif-h"><strong className="grow">Notifications</strong>{unread.length > 0 && <button className="btn btn-ghost btn-sm" onClick={markAll}>Mark all read</button>}</div>
          {notes.length === 0 && <div className="notif-empty"><Icon name="check" /> You are all caught up.</div>}
          <ul>
            {notes.map((n) => (
              <li key={n.id}>
                <a href={link(n)} className={read.has(n.id) ? 'read' : ''} onClick={() => { markOne(n.id); setOpen(false); }}>
                  <span className={`notif-ico ${n.tone}`}><Icon name={n.tone === 'good' ? 'check' : n.kind === 'review' ? 'clock' : 'alert'} small /></span>
                  <span className="grow"><b>{n.title}</b><span className="muted small">{n.detail} · {ago(n.at)}</span></span>
                  {!read.has(n.id) && <i className="unread-dot" aria-label="unread" />}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
