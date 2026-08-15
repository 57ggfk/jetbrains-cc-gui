import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeShellFileModification,
  isShellFileModificationRequest,
  evaluateShellFileModificationPolicy,
  isAllowShellFileModification,
} from './shell-file-modification.js';

describe('looksLikeShellFileModification', () => {
  it('detects redirects and common mutators', () => {
    assert.equal(looksLikeShellFileModification('echo hi > /tmp/a.txt'), true);
    assert.equal(looksLikeShellFileModification('cat <<EOF > file.js\nx\nEOF'), true);
    assert.equal(looksLikeShellFileModification("sed -i 's/a/b/' src/a.ts"), true);
    assert.equal(looksLikeShellFileModification('rm -rf dist'), true);
    assert.equal(looksLikeShellFileModification('mv a b'), true);
    assert.equal(looksLikeShellFileModification('tee out.txt'), true);
    assert.equal(looksLikeShellFileModification('git apply patch.diff'), true);
  });

  it('allows read-only / non-mutating commands', () => {
    assert.equal(looksLikeShellFileModification('ls -la'), false);
    assert.equal(looksLikeShellFileModification('cat package.json'), false);
    assert.equal(looksLikeShellFileModification('git status'), false);
    assert.equal(looksLikeShellFileModification('npm test'), false);
    assert.equal(looksLikeShellFileModification('echo hello'), false);
    assert.equal(looksLikeShellFileModification('pwd && date'), false);
  });
});

describe('isShellFileModificationRequest', () => {
  it('only flags shell tools', () => {
    assert.equal(
      isShellFileModificationRequest('Bash', { command: 'echo x > a.txt' }),
      true,
    );
    assert.equal(
      isShellFileModificationRequest('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
      false,
    );
    assert.equal(
      isShellFileModificationRequest('Bash', { command: 'ls' }),
      false,
    );
  });
});

describe('evaluateShellFileModificationPolicy', () => {
  it('denies by default', () => {
    const r = evaluateShellFileModificationPolicy(
      'Bash',
      { command: 'echo 1 > f.txt' },
      { allowShellFileModification: false },
    );
    assert.equal(r.action, 'deny');
    assert.match(r.message, /Edit or Write/i);
  });

  it('warns when allowed', () => {
    const r = evaluateShellFileModificationPolicy(
      'Bash',
      { command: 'sed -i s/a/b/ f.ts' },
      { allowShellFileModification: true },
    );
    assert.equal(r.action, 'warn');
    assert.match(r.message, /will not track/i);
  });

  it('passes non-mutating shell', () => {
    const r = evaluateShellFileModificationPolicy(
      'Bash',
      { command: 'ls' },
      { allowShellFileModification: false },
    );
    assert.equal(r.action, 'pass');
  });
});

describe('isAllowShellFileModification', () => {
  it('defaults false', () => {
    assert.equal(isAllowShellFileModification({}, () => null), false);
  });

  it('reads env when no config', () => {
    assert.equal(isAllowShellFileModification({ CODEMOSS_ALLOW_SHELL_FILE_MODIFICATION: 'true' }, () => null), true);
    assert.equal(isAllowShellFileModification({ CODEMOSS_ALLOW_SHELL_FILE_MODIFICATION: '0' }, () => null), false);
  });

  it('config overrides env', () => {
    assert.equal(
      isAllowShellFileModification({ CODEMOSS_ALLOW_SHELL_FILE_MODIFICATION: 'true' }, () => false),
      false,
    );
  });
});
