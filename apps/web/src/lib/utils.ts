/**
 * @fileoverview Class-name helper for the design system — merges conditional
 * class lists (clsx) and de-duplicates conflicting Tailwind utilities
 * (tailwind-merge), so later classes win predictably. Used by every primitive
 * in `components/ui/*`.
 *
 * @module web/lib/utils
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
