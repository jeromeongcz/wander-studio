import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { useAsync } from './hooks';
import { Icon } from './ui';

type Model = { id: string; name: string };

export function CodexModelMenu({ model, onChange }: { model: string | null; onChange: (model: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [requestedModels, setRequestedModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const models = useAsync(() => requestedModels
    ? api.get<Model[]>('/llm/providers/codex/models')
    : Promise.resolve([]), [requestedModels]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        if (root.current?.contains(document.activeElement)) trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  async function choose(next: string | null) {
    if (next === model) {
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await api.put('/llm/active', { providerId: 'codex', selectedModel: next });
      onChange(next);
      window.dispatchEvent(new Event('wander-llm-changed'));
      setOpen(false);
      if (root.current?.contains(document.activeElement)) trigger.current?.focus();
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const choices = [{ id: null, name: 'Default' }, ...(models.data ?? [])];
  const needsRestart = models.error instanceof ApiError && models.error.code === 'NOT_READY';
  return (
    <div className="codex-model-menu" ref={root}>
      <button
        className="ai-label codex-model-trigger"
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? 'codex-model-options' : undefined}
        aria-label={`Select Codex model (current: ${model ?? 'Default'})`}
        onClick={() => { setSaveError(''); setRequestedModels(true); setOpen(!open); }}
      >
        Codex · {models.data?.find((option) => option.id === model)?.name ?? model ?? 'Default'}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id="codex-model-options" className="codex-model-panel" role="group" aria-label="Select model" aria-busy={saving}>
          <div className="codex-model-heading">Select model</div>
          {choices.map(({ id, name }) => (
            <button key={id ?? ''} type="button" className="codex-model-option" aria-pressed={id === model} disabled={saving} onClick={() => void choose(id)}>
              <span>{name}{id === null && <small>Use the Codex default model</small>}</span>
              {id === model && <Icon name="check" small />}
            </button>
          ))}
          {models.loading && <p className="muted small" role="status">Loading models…</p>}
          {models.error && !models.loading && (
            <p className="small" role="alert">
              {needsRestart ? 'Restart Wander Studio to load Codex models.' : models.error.message}
              {' '}<button type="button" className="btn btn-ghost btn-sm" onClick={models.reload}>Retry</button>
            </p>
          )}
          {saveError && <p className="small" role="alert">{saveError}</p>}
        </div>
      )}
    </div>
  );
}
