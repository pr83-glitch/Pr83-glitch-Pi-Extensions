import type { ModeDefinition } from "../index.ts";

const plan: ModeDefinition = {
  id: "plan",
  label: "Plan",
  description: "Read-only planning mode",
  permissions: "plan",
  instructions:
    "You are in read-only planning mode. Plan or answer user questions only. Do not write files, edit files, or run state-changing commands.",
};

export default plan;
