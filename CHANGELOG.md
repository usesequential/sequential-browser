# Changelog

## 1.0.1

- README only: where the key comes from when there is no account yet (a trial that a coding agent creates with one call). No code change.

## 1.0.0

- First release: `init(options)` and `VERSION`. The SDK code is `sequential.js`, the file the script tag loads, with
  the same behaviour: autocapture, session replay, identify, accounts, opt-out (no id or session value stored before
  opt-in or while opted out) and the context cookie `__sq_ctx`.
