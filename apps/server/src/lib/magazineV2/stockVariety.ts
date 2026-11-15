// ---------------------------------------------------------------------------
// Magazine Builder v2 — "find ANOTHER photo": never the same picture twice, never a
// second copy of one.
//
// The Studio's add_stock_image asked Pexels for one result, and the search cache
// answered the same query identically for an hour — so "that horse photo isn't great,
// find another" put the SAME photo back, and stored a fresh copy of it in S3 and the
// media library every time (audit C46). Generation already had the cure, a per-issue
// ledger of the stock photos a magazine holds (photoDirector.seedStockLedger); this
// applies the same ledger to the chat path:
//
//   • the magazine's own media rows say which Pexels photos it already holds (by
//     provider id, or by fingerprint for rows older than that id);
//   • one search already returns a page of results, so the first one NOT held is used
//     — no extra API quota;
//   • when every result is already held, the existing library row for the best match is
//     handed back (no download, no new row) and the caller is told, so it can ask for
//     a different query instead of pretending it found something new.
//
// Pure: rows and candidates in, a decision out. The I/O is in stock.ts.
// ---------------------------------------------------------------------------

import { isStockTaken, seedStockLedger, stockFingerprint, type LedgerMediaRow } from './photoDirector.js';
import type { StockCandidate } from '../stock.js';

/** A media row as stock variety reads it (raw Mongo rows: everything optional). */
export interface StockMediaRow extends LedgerMediaRow {
  _id: string;
  url?: string;
  kind?: string;
}

/** The set of stock photos a magazine already holds, from its media rows. */
export function usedStockLedger(rows: ReadonlyArray<StockMediaRow>): Set<string> {
  const ledger = new Set<string>();
  seedStockLedger(ledger, rows);
  return ledger;
}

/** The library row holding this exact stock photo, if the magazine has one. */
export function stockRowFor(rows: ReadonlyArray<StockMediaRow>, candidate: StockCandidate): StockMediaRow | null {
  const fp = stockFingerprint(candidate);
  for (const row of rows) {
    if (!row || row.source !== 'stock' || typeof row.url !== 'string' || !row.url) continue;
    const id = typeof row.stockId === 'number' ? String(row.stockId) : typeof row.stockId === 'string' ? row.stockId.trim() : '';
    if (id && id === candidate.id) return row;
    if (!id && fp && stockFingerprint(row) === fp) return row;
  }
  return null;
}

export type StockChoice =
  | { kind: 'fresh'; candidate: StockCandidate }
  | { kind: 'reuse'; row: StockMediaRow; candidate: StockCandidate }
  | { kind: 'none' };

/**
 * What to place for a search: the first result the magazine does not hold yet; else
 * (every result already held) the existing row of the best match, to reuse rather than
 * copy; else nothing.
 */
export function chooseStock(candidates: ReadonlyArray<StockCandidate>, rows: ReadonlyArray<StockMediaRow>): StockChoice {
  if (candidates.length === 0) return { kind: 'none' };
  const ledger = usedStockLedger(rows);
  const fresh = candidates.find((c) => !isStockTaken(ledger, c));
  if (fresh) return { kind: 'fresh', candidate: fresh };
  for (const c of candidates) {
    const row = stockRowFor(rows, c);
    if (row) return { kind: 'reuse', row, candidate: c };
  }
  return { kind: 'none' };
}
