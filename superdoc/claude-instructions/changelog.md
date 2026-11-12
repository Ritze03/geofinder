# Changelog Maintenance

**Mandatory working rule for agents, linked (force-loaded) from the repo-root `CLAUDE.md`.**

`CHANGELOG.md` in the **repo root** is the user-facing "what changed". Write for users, not
developers: plain language, what changed for them, no implementation detail.

## The shape

```
# Changelog

<short preamble naming the categories>

## YYYY-MM-DD

### Added
- **Short name**: one or two sentences of what changed for the user.
```

- **`## YYYY-MM-DD`**: one block per calendar day, newest on top. No version numbers, per
  [`documentation-version-policy.md`](documentation-version-policy.md) (date-based).
- **`### Added` / `### Fixed` / `### Removed` / `### Info`**: the only four categories.
  Added = new features, Fixed = bug and behaviour fixes, Removed = things taken out,
  Info = notes worth knowing. Omit a category with no entries.
- **Bullets**: `- **Name**: sentence.` Bold only the lead-in. Wrap at about 90 columns,
  continuation lines indented two spaces.

## Rules

- **Maintain it as you work.** Every commit that changes what users get adds a bullet in the
  **same commit**, under today's `## YYYY-MM-DD` block. If that block is missing, create it
  at the top.
- **Never rewrite past blocks** or change their dates.
- **Skip internal-only changes**: docs, refactors, tests, CI, build tweaks with no visible
  effect. A day of only such work adds no block.
- **Anonymize**: no hostnames, usernames, emails, real names, absolute home paths or private
  project names.
