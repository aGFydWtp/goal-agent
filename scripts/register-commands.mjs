import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkinCommandDefinitions } from "../src/checkin-classification/commands.ts";
import { registerCommands } from "../src/discord/commands/register.ts";
import {
  EVIDENCE_COMMAND_NAME,
  GOAL_COMMAND_NAME,
  goalManagementCommandDefinitions,
} from "../src/goal-management/commands.ts";
import {
  draftCommandDefinition,
  evidenceListSubcommandDefinition,
  goalStatusSubcommandDefinition,
  statusCommandDefinition,
} from "../src/status-and-draft/commands.ts";

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadDevVars() {
  const path = resolve(process.cwd(), ".dev.vars");
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = unquote(trimmed.slice(index + 1));
    if (key !== "" && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseGuildId(argv) {
  const index = argv.indexOf("--guild-id");
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--guild-id requires a value");
    }
    return value;
  }

  const inline = argv.find((arg) => arg.startsWith("--guild-id="));
  if (inline !== undefined) {
    return inline.slice("--guild-id=".length);
  }

  return process.env.DISCORD_GUILD_ID;
}

function mergeSubcommand(definitions, topLevelName, subcommand) {
  return definitions.map((definition) => {
    if (definition.name !== topLevelName) {
      return definition;
    }
    return {
      ...definition,
      options: [...(definition.options ?? []), subcommand],
    };
  });
}

function buildCommandDefinitions() {
  let definitions = [
    ...goalManagementCommandDefinitions,
    ...checkinCommandDefinitions,
    statusCommandDefinition,
    draftCommandDefinition,
  ];
  definitions = mergeSubcommand(definitions, GOAL_COMMAND_NAME, goalStatusSubcommandDefinition);
  definitions = mergeSubcommand(
    definitions,
    EVIDENCE_COMMAND_NAME,
    evidenceListSubcommandDefinition,
  );
  return definitions;
}

loadDevVars();

const applicationId = process.env.DISCORD_APPLICATION_ID ?? "";
const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
const guildId = parseGuildId(process.argv.slice(2));
const definitions = buildCommandDefinitions();

const result = await registerCommands(
  applicationId,
  botToken,
  definitions,
  guildId === undefined || guildId === "" ? undefined : { guildId },
);

if (result.ok) {
  console.log(
    `Registered ${result.count} Discord command(s) to ${result.scope}${
      guildId === undefined || guildId === "" ? "" : ` guild ${guildId}`
    }.`,
  );
} else if (result.reason === "missing_credentials") {
  console.error(`Missing required environment value(s): ${result.missing.join(", ")}`);
  process.exitCode = 1;
} else {
  console.error(`Discord command registration failed with HTTP ${result.status}.`);
  if (result.body !== "") {
    console.error(result.body);
  }
  process.exitCode = 1;
}
