# v0.293.0 Release Checklist

**Target:** 0.292.1 → 0.293.0 (minor bump)
**Date:** 2026-07-20

## ✅ Completed (this session)

- [x] **5 breaking changes landed and tested:**
  - `jsonArgumentsBuggy` removal (`c1a2139b5`)
  - `streamFleet` → `fleetChatVerbosity` (`7cdf89ed0`, `f083ffeb7`)
  - `yoloDestructive`/`forceAllYolo`/`confirmDestructive` removal (`92cf18856`)
  - OAuth aliases + `ProviderAvailability` + `allowShell` removal (`221cd7ba5`)
- [x] **Security hardening:**
  - ACP safe-by-default permission policy (`b684bc692`)
  - `execFileSync` replaces `execSync` (`b684bc692`)
- [x] **Logger migration:** 5 files, 12 calls migrated + 3 compactor wiring
- [x] **Migration guide:** `docs/migration/v0.293.0.md`
- [x] **Breaking changes plan:** `docs/plans/breaking-changes-next-major.md`
- [x] **CHANGELOG.md:** `[0.293.0]` section with all breaking changes
- [x] **System audit report:** `docs/reports/system-audit-2026-07-20.md`
- [x] **Website update:** package metadata, homepage version, changelog data,
  and JSON-LD all report `0.293.0`
- [x] **Typecheck:** 12 packages clean (0 errors)
- [x] **Tests:** 10,674 passed, 0 failed (18 skipped)

## ⏳ Before `pnpm release`

- [ ] **Run `pnpm release:check`** — full gate (audit + build + typecheck + test)
- [ ] **Verify no `@deprecated` tags remain** in high-priority categories (3.1-3.5 cleared)

## 🚀 Release steps (maintainer)

```bash
# 1. Ensure clean tree
git status

# 2. Full gate
pnpm release:check

# 3. Bump version (all manifests + website)
node scripts/bump-version.mjs set 0.293.0

# 4. Update remaining website surfaces
#    - website/src/data/content.ts homepage version export
#    - website changelog array
#    - JSON-LD dateModified

# 5. Commit
git add -A
git commit -m "release: prepare v0.293.0"

# 6. Tag
git tag v0.293.0

# 7. Push
git push origin main --tags

# 8. Publish
pnpm release
```

## 📊 Session stats

| Metric | Value |
|--------|-------|
| Total commits (this session) | ~25 |
| Breaking changes | 5 |
| Files changed | ~60 |
| Packages typecheck-clean | 12/12 |
| Tests passed | 10,674 |
| Deprecated tags cleared | 23/29 |
| Migration guide sections | 7 |
