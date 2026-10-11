# pi-guard

Choose a **Plan** mode for cautious inspection or **Build** mode for normal work, with controls for tool access and approval prompts. Pi Guard helps make risky requests visible—but it is **not a sandbox** and cannot guarantee every unsafe action will be blocked. Keep this limitation in mind before relying on it.

## Install

1. From the repository folder containing `pi-guard/`, install:
   ```bash
   pi install ./pi-guard
   ```
2. Keep the folder in place; the personal install loads the extension from it.
3. Restart Pi or run `/reload`.

## First use

- Press **Alt+P** to switch modes, or run **`/guard`** to open the mode menu.
- Run **`/plan`** for Plan mode: built-in write and edit tools are denied, and Bash is restricted to matching inspection commands.
- Run **`/build`** for normal work. Configured risky commands and tools can require approval.
- Run **`/guard-tools`** to set supported tools to **Default**, **Allow**, **Ask**, or **Deny**.

Plan’s write/edit restrictions and limited Bash policy cannot be overridden by ordinary tool settings. New sessions start in Plan. When you navigate between conversation branches, Guard restores that branch’s last saved mode, or Plan if none was saved.

## Approvals and configuration

Read each approval prompt carefully. Allowing approves only that request: eligible non-Bash requests may be allowed once or for the exact same request in the current session; Bash and subagent requests are allow-once only. A different request is not covered. If Pi cannot display an approval prompt, the request is denied. Press **Esc** to deny.

Configuration is read from:

- Account: `~/.pi/agent/extensions/pi-guard/config.json`
- Trusted project: `.pi/extensions/pi-guard/config.json` (project tool rules take precedence)

The `config.json` included with the extension is **not loaded automatically**. Merge wanted settings into one of the locations above without replacing existing settings. For example:

```json
{
  "destructiveCommands": ["git push*"],
  "sensitivePatterns": ["*.secret"]
}
```

Lists such as `destructiveCommands` add to built-in defaults. Restart Pi or run `/reload` after configuration changes.

## Compatibility and safety limits

Requires **Pi 1.1.x** and **Node.js 22.13 or newer**. Plan Bash only permits commands matching its inspection list. Shell matching is not a full understanding of what programs do: variables, wildcards, wrappers, and arbitrary programs can hide risky effects. Unflagged does not mean safe. The separate `grep` tool is restricted to single-file searches in **both** Plan and Build; directory-content searches are blocked. Build Bash does not automatically ask about every command.

Pi Guard runs in-process with Pi’s normal operating-system permissions. Tool-name labels and “read-only” descriptions do not prove an action is safe. Protected-path checks do not contain general shell access, hard links, filesystem races, or malicious extensions. Use OS-level permissions or isolation for stronger protection, and keep independent backups of important data.

Only supported in-process agents created by `pi-subagents-lite` follow the parent session’s policy; approval requests may be sent to the parent. Other agent extensions and separate processes may not be covered and follow their own behavior.

Review the source before installing; extensions run with Pi’s operating-system permissions.

## Credits

Created by [Pr83-glitch](https://github.com/pr83-glitch).
