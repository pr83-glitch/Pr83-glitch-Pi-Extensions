// Child sessions can load Sleek in a separate extension runtime. Keep only plain
// activity data and one parent callback process-wide so /reload can reattach.
type ChildActivity = {
	agentId: string;
	prompt: string;
	model: string;
	tools: Map<string, string>;
	settled?: boolean;
	parentRowId?: string;
};
type ActivityBridge = { owner?: string; generation: number; notify?: () => void; children: Map<string, ChildActivity> };
const KEY = Symbol.for("pi-sleek.subagent-activity");
const shared = globalThis as typeof globalThis & { [KEY]?: ActivityBridge };
const bridge: ActivityBridge = shared[KEY] ??= { generation: 0, children: new Map() };
const childGenerations = new Map<string, number>();

/** Capture parent identity when a child binds, not when its async work completes. */
export function bindChildActivity(sessionId: string): void {
	childGenerations.set(sessionId, bridge.generation);
}
function currentChild(sessionId: string): boolean {
	return childGenerations.get(sessionId) === bridge.generation;
}

export function bindSubagentActivity(owner: string, notify: () => void): () => void {
	if (bridge.owner !== owner) {
		bridge.generation++;
		bridge.children.clear();
	}
	bridge.owner = owner;
	bridge.notify = notify;
	return () => { if (bridge.notify === notify) bridge.notify = undefined; };
}

export function startChildActivity(sessionId: string, sessionName: string | undefined, prompt: string, model: string): void {
	const agentId = sessionName?.match(/#([^#]+)$/)?.[1];
	if (!bridge.owner || !agentId || !currentChild(sessionId)) return; // Only named subagent sessions, not arbitrary SDK runs.
	const parentRowId = bridge.children.get(sessionId)?.parentRowId;
	bridge.children.set(sessionId, { agentId, prompt, model, tools: new Map(), settled: false, parentRowId });
	bridge.notify?.();
}

export function updateChildActivity(sessionId: string, toolCallId: string, toolName: string, working: boolean): void {
	const child = bridge.children.get(sessionId);
	if (!currentChild(sessionId) || !child || child.settled) return;
	if (working) child.tools.set(toolCallId, toolName);
	else child.tools.delete(toolCallId);
	bridge.notify?.();
}

export function finishChildActivity(sessionId: string, settled = true): void {
	const child = bridge.children.get(sessionId);
	if (!currentChild(sessionId) || !child) return;
	child.tools.clear();
	if (settled) child.settled = true;
	// Retain a bounded completion tail for same-parent reload reconciliation.
	const completed = [...bridge.children].filter(([, activity]) => activity.settled);
	for (const [id] of completed.slice(0, Math.max(0, completed.length - 100))) bridge.children.delete(id);
	bridge.notify?.();
}

export function getSubagentActivities(): readonly ChildActivity[] {
	return [...bridge.children.values()];
}
