---
name: review-user-errors
description: >-
  Fetches Bluring user-reported errors from the Vercel/Neon feedback_reports
  store, switches to Plan mode, and prepares a prioritized fix plan. Use when
  the user asks to check reported errors, review user feedback bugs, triage
  Vercel deploy feedback, go through feedback errors, or plan fixes from
  production Report error submissions.
---

# Review user errors (Vercel feedback → Plan)

Do **not** invent reports. Only use rows from Postgres or local `feedback/`.

## Workflow

Copy and track:

```
Progress:
- [ ] 1. Fetch production error reports
- [ ] 2. Optional: local feedback/ + ideas
- [ ] 3. Switch to Plan mode
- [ ] 4. Triage + write fix plan (no implementation yet)
```

### 1. Fetch production reports

From the repo root, run:

```bash
node .cursor/skills/review-user-errors/scripts/fetch-feedback-errors.cjs --kind error --limit 50
```

- Requires Vercel CLI logged in and project linked; pulls production env to query Neon.
- For ideas too: `--kind all` or `--kind idea`.
- Prefer this script over hand-rolled SQL. Do not print or commit env files (script deletes its temp env file).

**Fallback** (if script fails): `GET /api/feedback-list` with a valid access cookie, or `GET /api/feedback-list?id=<id>` for one full row. Schema: `api/helpers/feedbackDb.js` (`feedback_reports`).

### 2. Local disk (optional)

If `feedback/*.md` (and matching PNGs) exist, include them. Production path is DB + Blob; local folder is often empty on Vercel.

### 3. Switch to Plan mode

After you have the report list (even if empty), call **SwitchMode**:

- `target_mode_id`: `plan`
- `explanation`: brief note that you are planning fixes from user-reported Vercel feedback

Do **not** implement code in this skill run unless the user explicitly asks to execute the plan after reviewing it.

### 4. Triage and plan

For each **error** report, capture:

| Field | Source |
| ----- | ------ |
| Id | `id` |
| When | `created_at` |
| Tool | `tool_label` / `tool_id` |
| Task | `task_title` / `task_id` |
| Focus / wrong / expected | the three user answers |
| Screenshot | `screenshot_url` (open/inspect if present) |
| Session | `journal` timeline events |

Then:

1. Group duplicates (same tool + same symptom).
2. Rank by severity / user impact / how many reports.
3. For each prioritized item, sketch a **fix plan**: likely code areas (search the repo), root-cause hypothesis, concrete steps, test plan.
4. List **ideas** separately (nice-to-have; not blockers) if fetched.
5. End with an ordered checklist the user can approve before Agent mode implements.

## Plan output template

```markdown
# User-reported errors — fix plan

**Source:** production `feedback_reports` (Vercel/Neon) · fetched <ISO time>
**Errors:** N · **Ideas:** M (if any)

## Summary
One or two sentences: top themes.

## Prioritized bugs
### P1 — <short title>
- **Reports:** `<id>` (…dates…)
- **User:** focus / wrong / expected
- **Hypothesis:** …
- **Likely code:** paths or symbols to touch
- **Fix steps:** 1. … 2. …
- **Verify:** …

### P2 — …
…

## Ideas (non-blocking)
- …

## Proposed order
1. …
2. …
```

If **count is 0**: say so, still switch to Plan, and note nothing to fix unless the user wants to improve the feedback pipeline itself.

## Rules

- Never commit `.env.vercel*`, cookies, or secrets.
- Never claim a bug exists without a report id or local filename.
- Prefer fixing **errors** over shipping **ideas** unless the user says otherwise.
