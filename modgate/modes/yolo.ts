import type { ModeDefinition } from "../index.ts";

const yolo: ModeDefinition = {
  id: "yolo",
  label: "YOLO",
  description: "Work without ordinary approval prompts; retain protected-path and catastrophic-operation blocks",
  permissions: "yolo",
  instructions:
    "You are in YOLO mode. Make the requested changes without ordinary approval prompts. This is not a sandbox: scripts and unresolved runtime behavior remain your responsibility. Do not bypass a denial. In cases where a change could result in losing user data, create backup in ~/Documents/Backup/Agent\ Backup directory.",
};

export default yolo;
