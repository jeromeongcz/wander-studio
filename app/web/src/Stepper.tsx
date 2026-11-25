import { Icon } from './ui';

export interface StepItem {
  key: string;
  label: string;
  sub: string;
  href: string;
  done?: boolean;
  locked?: boolean;
  attention?: boolean;
  waiting?: boolean;
  title?: string;
}

/** The one production stepper, used by Video Production and by each video: a title block, then clickable steps. */
export function Stepper({ items, current, title, blurb }: { items: StepItem[]; current: number; title?: string; blurb?: string }) {
  return (
    <>
      {title && (
        <div className="step-title">
          <h2>{title}</h2>
          {blurb && <p className="muted">{blurb}</p>}
          <span className="step-num">STEP {current + 1} OF {items.length}</span>
        </div>
      )}
      <nav className="stepper" aria-label="Production steps">
        <ol>
          {items.map((s, i) => (
            <li key={s.key}>
              <a className={['step', s.done ? 'done' : '', i === current ? 'current' : '', s.locked ? 'locked' : '', s.attention ? 'attention' : s.waiting ? 'waiting' : ''].join(' ')} href={s.href} title={s.title} aria-current={i === current ? 'step' : undefined}>
                <span className="step-dot">{s.done ? <Icon name="check" /> : i + 1}</span>
                <span className="step-label">{s.label}</span>
                <span className="step-sub">{s.sub}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
