// Imported first by the CLI: hides node:sqlite's ExperimentalWarning (everything else still prints).
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: any, ...rest: any[]) => {
  if (String(w?.message ?? w).includes('SQLite')) return;
  return (emit as any)(w, ...rest);
}) as typeof process.emitWarning;
