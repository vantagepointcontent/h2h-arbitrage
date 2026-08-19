import { runBotSettlementReconciler } from '../src/lib/bot-settlement-reconciler';

if (!process.argv.includes('--apply')) {
  console.error('Refusing to mutate settlement ledger without --apply');
  process.exitCode = 2;
} else {
  const result = await runBotSettlementReconciler();
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length > 0) process.exitCode = 1;
}
