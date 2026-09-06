import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ordered, exhaustive release gate. Local routing is only iteration evidence.
export const releaseSteps = [
  'test', 'test:boundary-integration', 'test:layout-ui', 'test:ui',
  'test:arch-board-ui', 'test:business', 'test:customer-agent-python-tools',
  'lint:openapi', 'check:owner-contract', 'lint:owner-openapi',
  'test:sql-grammar', 'test:architecture-contract', 'check:arch-diagrams', 'audit:deps',
];

export function stepsForFiles(files) {
  if (!files.length) throw new Error('Provide explicit repository-relative task paths; the dirty worktree is not the task scope.');
  const steps = new Set(['test:docs:fast']);
  for (const file of files) {
    if (path.isAbsolute(file) || file.split('/').includes('..') || file.includes('\\')) throw new Error(`Invalid repository path: ${file}`);
    if (file.endsWith('.sql') || /\/openapi[^/]*\.ya?ml$/.test(file)) steps.add('test:machine-contracts');
    else if (/business-docs\/01-客服Agent项目\/0[0-6]-.*\.md$/.test(file)) steps.add('test:customer-contracts');
    else if (/20-设计-进行中\/.*\.(md|puml)$/.test(file)) steps.add('test:design-contracts');
    else if (file.endsWith('.md')) { /* wording-only; semantic boundaries require explicit tier */ }
    else return [...releaseSteps];
  }
  return [...steps];
}

export function shouldPublishPages({ GITHUB_REF, GITHUB_EVENT_NAME }) {
  // A newer docs-only push can cancel an older page push. Publish the complete
  // verified main checkout, never decide from only the newest commit's paths.
  return GITHUB_REF === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(GITHUB_EVENT_NAME);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = args.includes('--run');
  const files = args.filter(arg => !arg.startsWith('--'));
  const unknown = args.filter(arg => arg.startsWith('--') && !['--run', '--release'].includes(arg));
  if (unknown.length) throw new Error(`Unknown options: ${unknown.join(', ')}`);
  const steps = args.includes('--release') ? releaseSteps : stepsForFiles(files);
  console.log(JSON.stringify({ mode: run ? 'run' : 'plan-only', files, steps }));
  if (run) {
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    for (const step of steps) {
      const start = performance.now();
      const result = spawnSync('npm', ['run', step], { cwd, stdio: 'inherit', env: process.env });
      console.log(`[quality] ${step}: ${((performance.now() - start) / 1000).toFixed(2)}s, exit=${result.status}`);
      if (result.error || result.status !== 0) process.exit(result.status || 1);
    }
  }
}
