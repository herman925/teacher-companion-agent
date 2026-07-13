// Aggregator entry so `node --test tests/` works on Node >=23, where a bare
// directory positional is import-resolved (ERR_UNSUPPORTED_DIR_IMPORT) instead of
// scanned. Importing tests/ resolves here (package.json "main"), and this file
// imports every test module so all suites register under the one test run.
import './unit/harness.test.mjs';
import './unit/judges.test.mjs';
import './unit/glossary-data.test.mjs';
import './integration/harness-line.test.mjs';
// Runtime harness (the demo's L2/L3/L4 + engine) — lives next to the demo code.
import '../demo/tests/runtime-harness.test.mjs';
import '../demo/tests/mock-walkthrough.test.mjs';
import '../demo/tests/session-log.test.mjs';
