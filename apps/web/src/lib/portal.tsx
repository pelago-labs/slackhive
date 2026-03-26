'use client';

/**
 * @fileoverview React portal — renders children into document.body.
 * Ensures modals escape any parent overflow/transform constraints.
 *
 * @module web/lib/portal
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders children into document.body via a React portal.
 *
 * @param {{ children: React.ReactNode }} props
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
