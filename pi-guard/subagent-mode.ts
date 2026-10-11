import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi-subagents-lite creates named, in-memory children in this process. Its SDK
// sessions have no parent-session header or shared event bus. Share only the
// active interactive parent's policy; never treat an arbitrary SDK run as a child.
type PermissionMode = "plan" | "build";
export type ApprovalRequest = { event: import("@earendil-works/pi-coding-agent").ToolCallEvent; cwd: string; trusted: boolean; mode: PermissionMode; signal: AbortSignal };
type ParentPolicy = { sessionId: string; mode: PermissionMode; approve?: (request: ApprovalRequest, valid: () => boolean) => Promise<boolean> };
type Bridge = {
  parents: Set<ParentPolicy>;
  children: WeakMap<object, ParentPolicy | null>;
};
const KEY = Symbol.for("pi-guard.subagent-mode.v1");
const host = globalThis as typeof globalThis & { [KEY]?: Bridge };
const bridge = host[KEY] ??= { parents: new Set(), children: new WeakMap() };

export function isSupportedChild(ctx: ExtensionContext): boolean {
  return !ctx.hasUI && ctx.mode !== "tui" &&
    ctx.sessionManager.getSessionFile() === undefined &&
    /^.+#[0-9a-f]{8}$/i.test(ctx.sessionManager.getSessionName() ?? "");
}

export function bindParentPolicy(sessionId: string, mode: PermissionMode, approve?: ParentPolicy["approve"]): {
  update(mode: PermissionMode): void;
  dispose(): void;
} {
  const policy: ParentPolicy = { sessionId, mode, approve };
  bridge.parents.add(policy);
  return {
    update(next) {
      if (bridge.parents.has(policy)) policy.mode = next;
    },
    dispose() {
      bridge.parents.delete(policy);
    },
  };
}

export function inheritParentPolicy(sessionManager: object): () => PermissionMode {
  // ponytail: the supported runner has one interactive parent per process. If
  // several parents exist, require an explicit runner-provided parent ID instead
  // of guessing. Keep this lease tied to the original parent across replacement.
  if (!bridge.children.has(sessionManager)) {
    const parent = bridge.parents.size === 1 ? bridge.parents.values().next().value : undefined;
    bridge.children.set(sessionManager, parent ?? null);
  }
  // The manager identity survives extension reload. Never let an old child
  // reacquire Build from a replacement parent when its runtime binds again.
  const policy = bridge.children.get(sessionManager);
  return () => policy && bridge.parents.size === 1 &&
    bridge.parents.has(policy) ? policy.mode : "plan";
}

/** Never reacquire a lease or borrow a parent's cached grants. */
export async function requestParentApproval(manager: object, request: ApprovalRequest): Promise<boolean> {
  const policy = bridge.children.get(manager);
  const valid = () => !!policy && bridge.parents.size === 1 && bridge.parents.has(policy) &&
    policy.mode === request.mode && !request.signal.aborted;
  if (!valid() || !policy?.approve) return false;
  try { return await policy.approve(request, valid) && valid(); } catch { return false; }
}
