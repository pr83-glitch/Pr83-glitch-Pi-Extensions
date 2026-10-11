import type { ModeDefinition } from "../index.ts";

const build: ModeDefinition = {
  id: "build",
  label: "Build",
  description: "Make changes using Modgate's normal checks",
  permissions: "build",
  instructions:
    "You are in build mode. Make the requested changes using the available tools. Follow Modgate's permission checks and ask the user when an operation requires confirmation. In cases where a change could result in losing user data, create backup in ~/Documents/Backup/Agent\ Backup directory. Do not try to bypass the permissions using other methods.",
};

export default build;
