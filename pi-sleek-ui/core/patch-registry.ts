/** Small ownership-aware patch stack. Buried layers become inert on release. */
type Method = (...args: any[]) => any;
type PatchEntry = {
	owner: Record<string, unknown>;
	key: string;
	id: string;
	original: Method;
	installed: Method;
	delegate: Method;
};
const PATCH_REGISTRY = Symbol.for("pi-sleek.patch-registry");
function patchRegistry(): PatchEntry[] {
	const host = globalThis as typeof globalThis & { [PATCH_REGISTRY]?: PatchEntry[] };
	return (host[PATCH_REGISTRY] ??= []);
}

export function installPatch(owner: unknown, key: string, id: string, build: (original: any) => Method | undefined): boolean {
	if (!owner || typeof owner !== "object") return false;
	const target = owner as Record<string, unknown>;
	const current = target[key];
	if (typeof current !== "function") return false;
	const entries = patchRegistry();
	const existing = entries.find((entry) => entry.owner === target && entry.key === key && entry.id === id);
	// Never replace somebody else's newer layer when rebuilding our own.
	if (existing && current !== existing.installed) return false;
	const original = existing?.original ?? current as Method;
	const patched = build(original);
	if (typeof patched !== "function") return false;
	if (existing) existing.delegate = patched;
	else {
		const entry: PatchEntry = { owner: target, key, id, original, delegate: patched, installed: undefined! };
		entry.installed = function (this: unknown, ...args: any[]) { return entry.delegate.apply(this, args); };
		target[key] = entry.installed;
		entries.push(entry);
	}
	return true;
}

export function uninstallPatch(owner: unknown, key: string, id: string): void {
	const entries = patchRegistry();
	const index = entries.findIndex((entry) => entry.owner === owner && entry.key === key && entry.id === id);
	if (index < 0) return;
	const entry = entries[index]!;
	// Release the extension closure even when another wrapper retained us.
	entry.delegate = entry.original;
	try { if (entry.owner[key] === entry.installed) entry.owner[key] = entry.original; } catch { /* Best effort. */ }
	entries.splice(index, 1);
}

export function restorePatchedMethods(): void {
	for (const entry of [...patchRegistry()].reverse()) uninstallPatch(entry.owner, entry.key, entry.id);
}
