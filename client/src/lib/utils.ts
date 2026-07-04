import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number to fixed digits for display; em-dash for non-finite/undefined. */
export const fmt = (n: number | undefined, digits = 2) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';
