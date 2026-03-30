#!/usr/bin/env tsx
import { runCli } from "../src/cli.js";

const exitCode = await runCli();
process.exit(exitCode);
