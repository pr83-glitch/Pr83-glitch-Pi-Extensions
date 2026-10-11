# Modgate

Add **Plan**, **Build**, and **YOLO** modes to Pi, with controls for which tools can run and when Pi asks you first.

> **Important:** Modgate is an in-process safety aid, not a sandbox. It cannot guarantee that every unsafe command or action will be blocked. Read [Safety limits](#safety-limits) before relying on it.

**Requirements:** Pi 1.1.x and Node.js 22.13 or newer.

## Install

From the repository folder containing `modgate/`, run:

```bash
npm --prefix modgate install --ignore-scripts --legacy-peer-deps
pi install ./modgate
```

The local package needs its pinned `unbash` parser dependency installed first. Pi supplies the declared host peers; do not install a second copy of Pi into the extension.

This personal install loads the extension from that folder, so keep it in place. Restart Pi or run `/reload` to activate it. Review the source before installing; extensions run with Pi’s operating-system permissions.

## Use

- Start in **Plan** mode with `/plan`: built-in write and edit tools are denied, and Bash is limited to a list of inspection commands.
- Use `/build` for hands-free ordinary development: package-manager bootstrap/install, project caches, source edits, tests, typechecks, builds, and packaging. Visible destructive or privileged operations require approval; hard-denied operations cannot be approved away.
- Use `/yolo` for session-only work without ordinary approval prompts. There is **no activation confirmation**.
- Press **Alt+P** to cycle **Plan → Build → YOLO → Plan**, or use `/modgate` for the mode menu. Optional custom modes remain available through their commands/menu, not the three-mode shortcut cycle.
- Use `/modgate-tools` to choose **Default**, **Allow**, **Ask**, or **Deny** for supported tools.
- Use `/modgate explain` to inspect effective mode, inherited policy, config locations, and the last decision (tool-call ID, timestamp, reason code, and approval status). No full command is retained in this diagnostic record.
- Use the `modgate_search` tool for directory content searches. It performs bounded literal substring matching, skips protected files and symlinks, and accepts an optional filename glob.

Plan’s write/edit restrictions and limited Bash policy cannot be overridden by ordinary tool settings. Approval applies to the specific request being reviewed, not every future request. Modgate restores normal modes from the active conversation branch; YOLO is never automatically restored.

### YOLO policy

YOLO runs ordinary approval-required operations without prompting: arbitrary source deletion, destructive Git operations, privileged development commands, system writes, and remote-script pipelines can run. Both built-in Ask findings and configured Ask tool/command rules are skipped.

Hard blocks still apply to detected protected paths, disk formatting/irreversible wiping, recognized raw-device writes, deletion of the project root/ancestors/critical system paths, and explicit `deniedCommands` or Deny tool rules. Explicit Build Deny rules also remain effective in YOLO; a YOLO Allow rule cannot override them. YOLO and Subagent YOLO tool profiles expose Default/Deny choices.

Protected-content traversal rules still apply: use `modgate_search` for directory searches. File-list readers and search preprocessors remain blocked. Malformed shell input, parser failures, and analysis size/depth limits deny rather than silently bypassing inspection.

YOLO is a live, session-only mode. Entering it saves **Build** as the restoration fallback. Reload, resume, fork/branch restoration, or a new session does not reactivate YOLO; select it again explicitly. Supported children may inherit their live parent's YOLO policy, but cannot enable it independently. `/plan` and `/build` exit YOLO immediately.

This is **not a sandbox** or an undo mechanism. YOLO intentionally accepts unresolved runtime risks and trusts arbitrary scripts; only detected operations are checked. Back up important work before enabling it.

Bash is parsed as an AST: quoted regex alternation is not mistaken for a pipe, nested executable substitutions are inspected, and supported wrappers are unwrapped. In Plan, every operation must be an inspection command; assignments, writes, background execution, and unsupported executable constructs are blocked. Safe input redirects and diagnostic output redirects such as `2>/dev/null` and `2>&1` are permitted. Plan can allow `echo "$(pwd)"` but denies `echo "$(touch unwanted)"`.

Build is default-allow, not a development-command allowlist. Parser errors or unresolved risky operations ask rather than silently passing. Known wrappers include `env`, `command`, `exec`, `nice`, `nohup`, `timeout`, `sudo`, shell `-c`, `xargs`, and search execution forms. Unsupported wrapper options require review. `nohup` and `env` assignments are not allowed in Plan. Build allows `git restore` (including `git restore .`) by explicit policy; use approval-required Git commands such as `git reset --hard`, `git clean`, or forced push when you need their stronger warning.

In Plan/Build, decisions aggregate as **Deny > Ask > Allow**. Disk formatting/wiping, recognized device writes, critical-root deletion, protected-path access, and download-to-shell pipelines are hard-denied. Arbitrary deletion, destructive Git operations such as hard reset, clean, checkout replacement, and forced push, privilege escalation, recursive permissions, and system/process changes ask. `git restore` is intentionally excluded from this approval group in Build. Denials identify the effective mode and reason code. Protected-path errors identify the relevant path-bearing operand and matching rule, or distinguish a resolution error; environment assignments and regex text are no longer blindly treated as paths.

## Approvals and settings

Approval prompts show the request details. Review them before allowing an action. You can allow an eligible non-Bash request once or allow the exact same request for the current session; Bash and subagent requests are allow-once only. These approvals do not grant permission for different future requests. If Pi cannot show an approval prompt, the request is denied. You can scroll long requests; press Escape to deny.

Settings are read from:

- **For your Pi account:** `~/.pi/agent/extensions/modgate/config.json` (legacy `pi-modgate` location is still read)
- **For a trusted project:** `.pi/extensions/modgate/config.json` (legacy `pi-modgate` location is still read)

Project tool rules take precedence over account-wide rules. Lists such as `destructiveCommands` add to the built-in defaults. The `config.json` included in the downloaded extension folder is not loaded automatically: merge any settings you want into one of the locations above, without replacing existing settings. For example, to ask before matching `git push` commands and add a protected filename pattern:

```json
{
  "destructiveCommands": ["git push*"],
  "sensitivePatterns": ["*.secret"]
}
```

### Generated-output cleanup

Only a **trusted project's** `.pi/extensions/modgate/config.json` (legacy `pi-modgate` location is still read) can declare disposable paths:

```json
{
  "generatedPaths": [".cache", "dist"]
}
```

Merge this into existing settings; do not replace them. No disposable folder names are assumed by default, and global `generatedPaths` settings are ignored. Build can clean these locations without approval only when every deletion target is statically known, inside the canonical project root, inside a configured generated location, and not protected. The project root, ancestors, and critical system paths remain denied. Symlink escapes, unresolved targets, and source deletion are not eligible for automatic cleanup. Explicit configured Ask/Deny rules still apply.

Additional `destructiveCommands` rules ask; `deniedCommands` rules hard-deny. These patterns are matched against parsed command/argument text, including recognized wrapped operations. Rule precedence does not depend on JSON insertion order. Tool Allow never overrides shell risk checks or hard restrictions.

Restart Pi or run `/reload` after changing settings.

## Subagents and custom modes

Supported in-process agents created by `pi-subagents-lite` follow the parent session’s live Plan/Build/YOLO policy. Approval requests can be sent to the parent for review. Other agent extensions or agents running in separate processes may not be covered and use their own behavior.

Additional mode definitions can be placed in the extension’s `modes/` folder. They are optional; the built-in Plan, Build, and YOLO modes work without custom modes. Custom modes using `permissions: "yolo"` have the same session-only restoration restrictions.

## Safety limits

- Modgate checks visible shell operations, selected command-specific file operands, and tool requests—not every effect of a program. Build trusts ordinary project scripts, package lifecycle scripts, executables, Git configuration, and development dependencies. Allowing `npm run build` is not proof that its script is harmless. A command that is not flagged is **not guaranteed safe**.
- Static shell analysis has limits: unknown expansions, dynamic evaluation, unsupported options, and working-directory changes can require review. Complex shell constructs are intentionally conservative. Plan inspection commands are not proven effect-free for every possible option or runtime configuration.
- Protected-path checks help prevent direct access to matching files and follow symbolic links, but they do not contain general shell access, hard links, filesystem races, or malicious extensions.
- Tools and extensions run with Pi’s normal operating-system permissions. A tool’s name or “read-only” description is not proof of safety. Use OS-level isolation for stronger protection.
- Bash `rg`/`grep` and the separate `grep` tool require explicit safe single-file targets in all three modes. Directory content search uses `modgate_search`; raw recursive shell searches are not silently rewritten. Search preprocessors and unchecked file-list readers are blocked. `modgate_search` skips `.git` and `node_modules`, caps traversal/bytes/output, and reports when limits are reached. Its literal query is not a regular expression.
- A diagnostic status of permitted means Modgate allowed execution—not that the command ran or succeeded. A denial is issued before execution through this guard hook. Artifacts/logs from another invocation must not be attributed to a denied request without matching provenance.
- Backup instructions are guidance, not verified backups. Keep independent backups of important data.

For more detail about configuration and limitations, see the relevant sections in this README and Pi’s project-trust settings.

## Credits

Created by [Pr83-glitch](https://github.com/pr83-glitch).
