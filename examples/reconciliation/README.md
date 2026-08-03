# Synthetic reconciliation fixtures

`mock-provider-golden.csv` demonstrates the exact accepted header and normalized field forms. Its public-looking identifiers and merchant code are synthetic and are not expected to match a fresh local database until an integration test provisions corresponding evidence.

Never place production/provider exports or real merchant references in this directory. Reconciliation computes expected results from the database snapshot in the submitted window; the fixture is an input-shape example, not an editable accounting source of truth.
