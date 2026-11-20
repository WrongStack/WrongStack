import { describe, expect, it } from 'vitest';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';
import { hasExternalPublish, hasGitHistoryRewrite } from '../../src/security/yolo-vcs-risk.js';

/**
 * F9: AWS CLI v2 (argparse-based) accepts unambiguous long-option prefixes, so
 * `aws s3 rm s3://bucket --rec` deletes exactly like `--recursive`. The cloud
 * delete gates compared these flags by exact equality, so the abbreviated
 * spellings — remote, irreversible data destruction — were classified safe
 * under YOLO. Verified empirically on aws-cli/2.39.7:
 *   s3 rm --recursive: --rec… ("re"/"r" resolve to the global --region;
 *       --rec reaches the SAME ListObjectsV2 recursive-delete path)
 *   s3 rb --force: --f… (same parse outcome as the --force control)
 *   s3 sync --delete: --del… ("de"/"d" resolve to --debug, NOT --delete)
 * gcloud/gsutil branches are unchanged (their parsers were not verifiable
 * locally; see the round ledger).
 */
describe('AWS CLI unambiguous long-option abbreviations are gated (F9)', () => {
  const ROOT = '/tmp/some-project';

  it.each([
    'aws s3 rm s3://bucket --rec',
    'aws s3 rm s3://bucket --recu',
    'aws s3 rm s3://bucket --recursi',
    'aws s3 rm s3://bucket --recursive',
    'aws s3 rb s3://bucket --forc',
    'aws s3 rb s3://bucket --f',
    'aws s3 rb s3://bucket --force',
    'aws s3 sync s3://src s3://dst --del',
    'aws s3 sync s3://src s3://dst --dele',
    'aws s3 sync s3://src s3://dst --delete',
  ])('gates the cloud delete: %s', (cmd) => {
    expect(hasExternalPublish(cmd)).toBe(true);
  });

  it.each([
    'aws s3 rm s3://bucket --rec',
    'aws s3 rb s3://bucket --forc',
    'aws s3 sync s3://a s3://b --del',
  ])('classifies end-to-end as publish: %s', (cmd) => {
    expect(classifyDestructiveCommand(cmd, ROOT)).toBe('publish');
  });

  it.each([
    'aws s3 rm s3://bucket --re us-east-1',
    'aws s3 rm s3://bucket --region us-east-1',
    'aws s3 rm s3://bucket --request-payer requester',
    'aws s3 rm s3://bucket/key',
    'aws s3 rb s3://bucket',
    'aws s3 sync s3://src s3://dst --dryrun',
    'aws s3 sync s3://src s3://dst --de',
    'aws s3 sync s3://src s3://dst --d',
    'aws s3 sync s3://src s3://dst --debug',
    'aws s3 ls s3://bucket',
    'aws s3 cp s3://src s3://dst',
    'aws s3 presign s3://bucket/key',
  ])('keeps the non-delete spelling safe: %s', (cmd) => {
    expect(hasExternalPublish(cmd)).toBe(false);
  });

  it('handles =value over-match, chained, and flag-before-path forms', () => {
    // AWS rejects --rec=x (recursive takes no value); over-matching is fail-safe.
    expect(hasExternalPublish('aws s3 rm s3://bucket --rec=x')).toBe(true);
    expect(hasExternalPublish('true; aws s3 rm s3://b --rec')).toBe(true);
    expect(hasExternalPublish('aws s3 rm --rec s3://b')).toBe(true);
  });

  it('keeps the other publish/teardown gates intact', () => {
    for (const cmd of [
      'npm publish',
      'cargo publish',
      'kubectl delete namespace prod',
      'terraform destroy',
      'gsutil rm -r gs://bucket',
      'gcloud storage rm --recursive gs://bucket',
      'rclone purge remote:bucket',
    ]) {
      expect(hasExternalPublish(cmd)).toBe(true);
    }
    expect(hasExternalPublish('terraform plan -destroy')).toBe(false);
  });

  it('leaves the F8 git abbreviation gates intact (shared helper)', () => {
    for (const cmd of [
      'git reset --har HEAD~1',
      'git clean --forc -d',
      'git push --force-w',
      'git push --mirr',
      'git switch --disc main',
      'git restore --staged --wor file',
      'git gc --pru=now',
    ]) {
      expect(hasGitHistoryRewrite(cmd)).toBe(true);
    }
    for (const cmd of [
      'git push --forc',
      'git switch --forc',
      'git push --dry-run',
      'git restore --sta file',
    ]) {
      expect(hasGitHistoryRewrite(cmd)).toBe(false);
    }
  });
});
