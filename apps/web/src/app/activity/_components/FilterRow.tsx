'use client';

/**
 * @fileoverview Agent + time-window filter row shared between the Activity
 * kanban and the Usage dashboard. State lives in the parent; this component
 * just renders the two selects and raises change events.
 *
 * @module web/app/activity/_components/FilterRow
 */

import React from 'react';
import { Filter as FilterIcon } from 'lucide-react';

export type WindowKey = '1h' | '24h' | '7d' | '30d';

interface AgentOption {
  id: string;
  name: string;
}

export const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: '1h',  label: 'Last 1 hour' },
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d',  label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

const selectStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: 'var(--text)',
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
};

export function FilterRow(props: {
  agents: AgentOption[];
  agentFilter: string;
  windowKey: WindowKey;
  onAgentChange: (id: string) => void;
  onWindowChange: (w: WindowKey) => void;
}): React.JSX.Element {
  const { agents, agentFilter, windowKey, onAgentChange, onWindowChange } = props;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
      padding: '10px 14px', background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 10,
    }}>
      <FilterIcon size={14} style={{ color: 'var(--muted)' }} />
      <select
        value={agentFilter}
        onChange={e => onAgentChange(e.target.value)}
        style={selectStyle}
      >
        <option value="">All agents</option>
        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select
        value={windowKey}
        onChange={e => onWindowChange(e.target.value as WindowKey)}
        style={selectStyle}
      >
        {WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
      </select>
    </div>
  );
}
