## What this changes

<!-- One or two sentences. What was wrong, or what is new. -->

## Why

<!-- The reasoning a reviewer cannot recover from the diff. -->

## Evidence

<!--
For a behaviour change, the before/after numbers. "It finds more now" is hard to
review; "tsinghua.edu.cn went from 25 to 36 URLs" is not.
For a bug fix, how you reproduced it and what the fix does.
-->

- Before:
- After:

## Checklist

- [ ] `npm run verify` passes (typecheck, build, browser check, tests)
- [ ] Added or updated a test that would fail without this change
- [ ] If behaviour deliberately reproduces a quirk of the Go original, the code says so in a comment
- [ ] If adding a plugin: registered in `createDefaultRegistry()` and `BUILTIN_PLUGIN_NAMES`
- [ ] No Node builtin reaches `src/browser.ts` through a static import
