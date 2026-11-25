import { useState } from 'react';

type Range = 'any' | 'today' | '7' | '30' | 'custom';
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return day(d); };

/**
 * Search, date, category and order controls for one list of topics. Dates are compared as calendar days in this
 * computer's time zone. `dateOf` says which date the list is about (approval date or research date).
 */
export function useTopicFilter(list: any[], dateOf: (t: any) => string, what: string) {
  const [q, setQ] = useState('');
  const [range, setRange] = useState<Range>('any');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [order, setOrder] = useState<'new' | 'old'>('new');
  const categories = [...new Set(list.map((t) => t.category).filter(Boolean))].sort() as string[];
  const [low, high] = range === 'today' ? [daysAgo(0), daysAgo(0)] : range === '7' ? [daysAgo(6), ''] : range === '30' ? [daysAgo(29), ''] : range === 'custom' ? [from, to] : ['', ''];
  const needle = q.trim().toLowerCase();
  const shown = list
    .filter((t) => {
      const d = day(new Date(dateOf(t)));
      return (!low || d >= low) && (!high || d <= high) && (!category || t.category === category) && (!needle || `${t.title} ${t.hook}`.toLowerCase().includes(needle));
    })
    .sort((a, b) => (order === 'new' ? dateOf(b).localeCompare(dateOf(a)) : dateOf(a).localeCompare(dateOf(b))));
  const active = !!(needle || range !== 'any' || category);
  const clear = () => { setQ(''); setRange('any'); setFrom(''); setTo(''); setCategory(''); };
  const bar = list.length === 0 ? null : (
    <div className="filters" role="group" aria-label={`Filter ${what}`}>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title" aria-label={`Search ${what}`} />
      <select value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label={`Date of ${what}`}>
        <option value="any">Any date</option>
        <option value="today">Today</option>
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="custom">Pick dates…</option>
      </select>
      {categories.length > 1 && (
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={`Category of ${what}`}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <select value={order} onChange={(e) => setOrder(e.target.value as 'new' | 'old')} aria-label={`Order of ${what}`}>
        <option value="new">Newest first</option>
        <option value="old">Oldest first</option>
      </select>
      {range === 'custom' && (
        <div className="filter-dates">
          <label>From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      {active && <div className="filter-foot"><span className="muted small">{shown.length} of {list.length} shown</span><button type="button" className="btn btn-ghost btn-sm" onClick={clear}>Clear filters</button></div>}
    </div>
  );
  return { shown, bar, empty: list.length > 0 && shown.length === 0 };
}
