import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { planSessionVacuum, type Entry } from "../session-ledger/index.js";

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

function serializeEntry(entry: Entry): string {
	return JSON.stringify(entry);
}

export function registerVacuumCommand(pi: ExtensionAPI, _runtime: Runtime): void {
	pi.registerCommand("om:vacuum", {
		description: "Rewrite the session file dropping superseded compaction snapshots and dead branches (backup kept)",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			if (!sessionFile || !existsSync(sessionFile)) {
				ctx.ui.notify("Observational memory: /om:vacuum needs a saved session file", "warning");
				return;
			}

			const raw = readFileSync(sessionFile, "utf-8");
			const lines = raw.split("\n").filter((line) => line.trim().length > 0);
			if (lines.length === 0) {
				ctx.ui.notify("Observational memory: session file is empty; nothing to vacuum", "info");
				return;
			}

			let header: string | undefined;
			const entries: Entry[] = [];
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as Record<string, unknown>;
					if (!header && parsed.type === "session") {
						header = line;
						continue;
					}
					if (typeof parsed.id === "string") entries.push(parsed as unknown as Entry);
				} catch {
					// Skip unparseable lines rather than aborting the whole vacuum.
				}
			}

			const plan = planSessionVacuum(entries);
			if (plan.removedIds.length === 0 && plan.strippedCompactions === 0) {
				ctx.ui.notify("Observational memory: nothing to vacuum (no superseded compactions or dead branches)", "info");
				return;
			}

			const backupFile = `${sessionFile}.bak`;
			copyFileSync(sessionFile, backupFile);
			const tempFile = `${sessionFile}.vacuum-tmp`;
			const out = [header ?? "", ...plan.kept.map(serializeEntry)].filter((line) => line.length > 0);
			writeFileSync(tempFile, `${out.join("\n")}\n`);

			const beforeBytes = statSync(sessionFile).size;
			const afterBytes = statSync(tempFile).size;
			if (afterBytes >= beforeBytes) {
				// A vacuum that does not shrink the file is a bug; keep the original.
				renameSync(tempFile, `${sessionFile}.vacuum-rejected`);
				ctx.ui.notify("Observational memory: vacuum produced no size reduction; original file kept", "warning");
				return;
			}
			renameSync(tempFile, sessionFile);

			ctx.ui.notify(
				[
					`Observational memory: session file vacuumed ${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}.`,
					`Stripped ${plan.strippedCompactions} superseded compaction snapshot(s); removed ${plan.removedIds.length} dead-branch entry/entries.`,
					`Backup: ${backupFile}`,
					"Restart pi (or reload the session) so the in-memory session state matches the rewritten file.",
				].join("\n"),
				"info",
			);
		},
	});
}
