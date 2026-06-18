---
description: "Use when writing commit messages, PR titles, or changelog summaries. Enforces the repository's conventional commit format and scope conventions."
---

# Commit Message Guidelines

- Use the format: `<type>(<scope>): <subject>`
- Keep the subject short, clear, and in present tense.
- Prefer Japanese when natural and consistent with the current project context.

## Type

Use one of the following:

- `feat`: new or changed feature
- `fix`: bug fix
- `docs`: documentation only
- `style`: formatting / whitespace / linting
- `refactor`: structural change without behavior change
- `test`: tests added or refactored
- `chore`: maintenance tasks
- `perf`: performance improvement
- `ci`: CI/CD changes
- `revert`: revert a previous commit

## Scope

Use the part of the codebase affected:

- `ui` for UI changes, or `ui/$ClassName` / `ui/$ModuleName`
- `api` for API changes, or `api/$operationId` / `api/$path`
- `$ClassName` or `$ModuleName` for other code areas

## Subject

- Summarize the change in one concise line.
- Prefer action-oriented wording such as "追加", "改善", "修正" when appropriate.
- Avoid vague words like "update", "fix", or "change" without context.

## Examples

- `chore(package.json): 依存関係のアップデート`
- `feat(ui/ExampleView): サンプルボタンの追加`
- `perf(TSFilter): チャンク処理のパフォーマンスを向上`
