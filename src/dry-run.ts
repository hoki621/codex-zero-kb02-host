const states = process.argv[2] ?? "EEEEEE";
if (!/^[WIBDUE]{6}$/.test(states)) {
  console.error("usage: npm run dry-run -- <six state codes: WIBDUE>");
  process.exitCode = 1;
} else {
  console.log(`STATE 1 - ${states}`);
}
