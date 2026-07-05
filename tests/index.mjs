// Aggregator entry so `node --test tests/` works on Node >=23, where a bare
// directory positional is import-resolved (ERR_UNSUPPORTED_DIR_IMPORT) instead of
// scanned. Importing tests/ resolves here (package.json "main"), and this file
// imports every test module so all suites register under the one test run.
import './unit/harness.test.mjs';
import './unit/judges.test.mjs';
import './unit/glossary-data.test.mjs';
import './integration/harness-line.test.mjs';
