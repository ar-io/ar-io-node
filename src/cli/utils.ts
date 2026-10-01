/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The command plumbing of the `ar.io` CLI in `@ar.io/sdk` (`src/cli/utils.ts`),
 * mirrored with the same names and behaviour so `ar-io-node` commands look and
 * fail exactly like the SDK's: flat kebab-case names, options from one
 * registry, the result as indented JSON on stdout and exit 0, an error's
 * message on stderr (its stack with `--debug`) and exit 1. Mirrored rather
 * than imported: the SDK exports no CLI modules, and its CLI internals are
 * not a public contract.
 */
import { Command, program } from 'commander';

import { globalOptions } from './options.js';
import type {
  CommanderOption,
  GlobalCLIOptions,
  JsonSerializable,
} from './types.js';

export function stringifyJsonForCLIDisplay(json: unknown): string {
  return JSON.stringify(json, null, 2);
}

function logCommandOutput(output: JsonSerializable): void {
  console.log(stringifyJsonForCLIDisplay(output));
}

function exitWithErrorLog(error: unknown, debug = false): never {
  let errorLog: string;
  if (error instanceof Error) {
    errorLog = error.message;
    if (debug && error.stack !== undefined) {
      errorLog = error.stack;
    }
  } else {
    errorLog = stringifyJsonForCLIDisplay(error);
  }
  console.error(errorLog);
  process.exit(1);
}

/**
 * Runs a command's handler: prints what it returns and exits 0, or prints
 * what it throws and exits 1. A handler that must fail with a structured
 * result (a failed check, say) throws that result object.
 */
export async function runCommand<O extends GlobalCLIOptions>(
  command: Command,
  action: (options: O) => Promise<JsonSerializable>,
): Promise<void> {
  const options = command.optsWithGlobals<O>();
  try {
    const output = await action(options);
    logCommandOutput(output);
    process.exit(0);
  } catch (error) {
    exitWithErrorLog(error, options.debug);
  }
}

export function applyOptions(
  command: Command,
  options: CommanderOption[],
): Command {
  [...options].forEach((option) => {
    command.option(option.alias, option.description, option.default);
  });
  return command;
}

/** Registers a command on the shared `program`, with the global options. */
export function makeCommand<O extends GlobalCLIOptions = GlobalCLIOptions>({
  name,
  description,
  options = [],
  action,
}: {
  name: string;
  description: string;
  options?: CommanderOption[];
  action?: (options: O) => Promise<JsonSerializable>;
}): Command {
  const command = program.command(name).description(description);
  const appliedCommand = applyOptions(command, [...options, ...globalOptions]);
  if (action !== undefined) {
    appliedCommand.action(() => runCommand<O>(appliedCommand, action));
  }
  return appliedCommand;
}

export function requiredStringFromOptions<O extends GlobalCLIOptions>(
  options: O,
  key: string,
): string {
  const value = options[key];
  if (value === undefined) {
    throw new Error(`--${kebab(key)} is required`);
  }
  return value;
}

export function positiveIntegerFromOptions<O extends GlobalCLIOptions>(
  options: O,
  key: string,
): number | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  const numberValue = +value;
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new Error(
      `Invalid ${kebab(key)}: ${value}, must be a positive integer`,
    );
  }
  return numberValue;
}

/** A comma-separated option as a list, empty entries dropped. */
export function stringListFromOptions<O extends GlobalCLIOptions>(
  options: O,
  key: string,
): string[] | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const kebab = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
