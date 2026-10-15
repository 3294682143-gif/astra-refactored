# G7/PR7 + G8/PR8 — local audit report (pre-closure)

Baseline `feat/v4-dynamic-workflows`. This report is a **local, verifiable
pre-audit**; it is NOT `MIGRATION_COMPLETION.md` and does not sign off G8/PR8.

## RC2 source inventory (mechanically enumerated)
- 260 unique RC2 source paths in `docs/MIGRATION_MATRIX.csv`; `docs/SOURCE_INVENTORY.csv` also 260 rows.
- 0 unmatched (`matched_rule` non-empty, `target_exists=True`), 260 `REVIEW_REQUIRED`, 0 `CLOSED`.
- Evidence-linked v4 `test`/`evidence` records: **100**; still pending: **160**.

By classification (all 260): {'CONFIG': 3, 'DOC': 9, 'ASSET': 86, 'MATH': 132, 'RUNTIME': 20, 'HOST': 9, 'TEST': 1}.
Pending evidence by classification (160): {'CONFIG': 3, 'DOC': 9, 'MATH': 60, 'ASSET': 62, 'RUNTIME': 17, 'HOST': 8, 'TEST': 1}.

## a2 increments
- 16 a2 source changes inventoried separately in `docs/A2_SOURCE_CHANGES.csv`; disposition tracking is not yet closed.

## External blockers (unchanged)
- `docs/RELEASE_BLOCKERS.md` B1–B4 (real official 书生 S2 API, target sandbox Node/subprocess,
  WASI accepted profile, real A/B/C/D comparison) remain **BLOCKED_EXTERNAL**; none is fabricated as done.
- Slice 7e TS caller (M2/M3/M5 issuing `asset.scoped` + S1/S3 evidence binding) is **not implemented**,
  so Slice 7e is **not complete**; Slice 7f evidence back-fill is partial (160 rows).

## Slice status at this report
- Slice 7d — DONE, committed `5510160`.
- Slice 7e — host+registry layer `f2c794d`; TS caller plumbing `219c6f7`/`240b092`; **S1 checker binding `e3bf2e1`**; **S3 binding + M2/M3 mathFamilies/skills/prompts consumption still pending -> not complete**.
- Slice 7f — partial (GATEBOARD rows + this report); 260-row evidence back-fill not finished.
- Local acceptance remains green: `tsc -b` 0; Node **311/0**; `pytest tests/e2e` >=213; `pytest -q` **619 passed / 24 skipped**.

## Discipline
No push. No token/key written to any file/log/receipt. No completion is claimed; ownership/evidence
gaps above remain open.
