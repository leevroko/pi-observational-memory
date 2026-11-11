import type { Entry } from "./types.js";

export type VacuumPlan = {
	/** Entries to keep, in order: the current leaf path with superseded compactions stripped. */
	kept: Entry[];
	/** Entry ids removed from the file (off-path branches and pruned content). */
	removedIds: string[];
	/** How many superseded compaction entries were stripped in place (kept as stubs). */
	strippedCompactions: number;
};

function isCompactionEntry(entry: Entry): boolean {
	return entry.type === "compaction";
}

/**
 * Plan a file-level vacuum for an append-only session ledger.
 *
 * The session file keeps every historical compaction summary forever. Each summary
 * is a full memory snapshot, so a long-lived session accumulates hundreds of
 * megabytes of superseded snapshots that pi parses and retains on every resume.
 *
 * The plan keeps the tree intact where it matters:
 * - The current leaf path (last entry -> root via parentId) is kept in full, so
 *   ids, parent chains, the memory ledger, and recall sources survive.
 - The LATEST compaction on the path is kept verbatim (it is the active context).
 * - Older compactions ON the path are kept as stubs (same id/parentId/timestamp,
 *   empty summary, no details) so the parent chain stays linked while their
 *   multi-megabyte payloads stop being parsed on every resume.
 * - Entries off the current path (abandoned branches) are removed entirely.
 *
 * Compaction stubs are safe because pi's context builder only reads the latest
 * compaction on the leaf path, and the extension's projections fold the ledger,
 * not old summaries.
 */
export function planSessionVacuum(entries: Entry[]): VacuumPlan {
	if (entries.length === 0) {
		return { kept: [], removedIds: [], strippedCompactions: 0 };
	}

	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const keptIds = new Set<string>();
	let cursor: Entry | undefined = entries[entries.length - 1];
	while (cursor) {
		keptIds.add(cursor.id);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}

	let lastCompactionId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (keptIds.has(entry.id) && isCompactionEntry(entry)) {
			lastCompactionId = entry.id;
			break;
		}
	}

	const kept: Entry[] = [];
	const removedIds: string[] = [];
	let strippedCompactions = 0;
	for (const entry of entries) {
		if (!keptIds.has(entry.id)) {
			removedIds.push(entry.id);
			continue;
		}
		if (isCompactionEntry(entry) && entry.id !== lastCompactionId) {
			const stub: Record<string, unknown> = {
				type: entry.type,
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				summary: "",
				firstKeptEntryId: entry.firstKeptEntryId,
			};
			kept.push(stub as unknown as Entry);
			strippedCompactions++;
			continue;
		}
		kept.push(entry);
	}

	return { kept, removedIds, strippedCompactions };
}
