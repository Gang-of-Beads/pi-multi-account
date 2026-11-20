#!/usr/bin/env node
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
try {
	const { main } = await jiti.import("../src/cli.ts");
	await main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`pi-multi-account: ${error instanceof Error ? error.message : "command failed"}\n`);
	process.exitCode = 1;
}
