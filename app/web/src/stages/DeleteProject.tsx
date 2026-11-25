import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Btn, CopyBtn, Field, Loading, Modal, Pill, fmtBytes, useToast } from '../ui';

/** Danger zone: permanently delete this project. Shows what goes, offers a backup, and needs the exact name. */
export function DeleteProject({ project }: { project: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="row gap wrap">
        <Btn kind="danger" onClick={() => setOpen(true)}>Delete this project…</Btn>
        <span className="muted small">Permanently removes the project, its approvals, and all its files. It cannot be undone.</span>
      </div>
      {open && <DeleteDialog project={project} onClose={() => setOpen(false)} />}
    </>
  );
}

function DeleteDialog({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const { push } = useToast();
  const preview = useAsync(() => api.get<any>(`/projects/${project.id}/deletion-preview`), [project.id]);
  const [typed, setTyped] = useState('');
  const [backup, setBackup] = useState<{ path: string; bytes: number } | null>(null);
  const p = preview.data;
  const matches = typed === project.name;
  return (
    <Modal title={`Delete “${project.name}”?`} onClose={onClose}>
      {!p ? <Loading /> : (
        <div className="stack">
          <div className="notice bad">
            <strong>This cannot be undone.</strong> Deleting removes:
            <ul>
              <li>{p.artifacts} steps{p.approved > 0 && <> (<strong>{p.approved} you approved</strong>)</>} with all their version history</li>
              <li>{p.assets} assets, {p.audio_clips} audio clips and {p.renders} rendered videos</li>
              <li>{p.files} files on disk ({fmtBytes(p.bytes)})</li>
            </ul>
          </div>
          <div className="muted small">Kept: {p.keeps.join('; ')}.</div>
          {p.active_jobs > 0 && <div className="notice warn">This project has {p.active_jobs} queued or running job(s). Cancel them in Jobs &amp; settings first.</div>}
          <div className="stack">
            <div className="row gap wrap">
              <Btn onClick={async () => { setBackup(await api.post(`/projects/${project.id}/archive`)); push('ok', 'Backup archive created'); }} disabled={!!backup}>{backup ? 'Backup created' : 'Back up first (create archive)'}</Btn>
              {backup && <><span className="small mono" style={{ wordBreak: 'break-all' }}>{backup.path}</span><CopyBtn text={backup.path} label="Copy path" /></>}
            </div>
            <span className="muted small">An archive can be restored later as a new project from the Publish page.</span>
          </div>
          <Field label={`Type the project name to confirm: ${project.name}`}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder={project.name} aria-label="Confirm project name" autoComplete="off" />
          </Field>
          <div className="row gap">
            <Btn kind="danger" disabled={!matches || p.active_jobs > 0} onClick={async () => {
              await api.post(`/projects/${project.id}/delete`, { confirm_name: typed });
              push('ok', `Deleted “${project.name}”`);
              location.hash = '#/projects';
            }}>Delete permanently</Btn>
            <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
            {typed && !matches && <Pill tone="warn">Name does not match yet</Pill>}
          </div>
        </div>
      )}
    </Modal>
  );
}
