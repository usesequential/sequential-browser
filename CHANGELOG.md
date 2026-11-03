# Changelog

## 1.0.2

- The package now holds the same code as the script tag of 3 November 2026. Changes since 1.0.0:
  - Back or Forward is recorded as a pop, also when the app's router answers it with `replaceState`, and a hash-route
    link is recorded as a push. Without the Navigation API, both are recorded as unknown.
  - A `replaceState` that changes only the query is not a pageview.
  - A click sends the element's `aria-label` (`$el_label`) and its link target (`$el_href`).
  - A person's id is never sent as `$anon_distinct_id`; a second sign-in on one browser no longer moves the first
    person's history.
  - `optOut()` also deletes the recorder's `__lx_replay_sample`, and another tab's `optOut()` opts this tab out at once.
  - A held batch is sent again after each pause, as its own request, for up to 5 minutes.
  - The account-menu privacy check no longer treats every "profile" as account UI.
  - In a URL, the user info is removed up to the last `@` of the authority, so a password that contains `@` no longer
    leaves its end in the URL.
  - The "no data-key" and "no data-api" console lines say how to configure without attributes.

## 1.0.1

- README only: where the key comes from when there is no account yet (a trial that a coding agent creates with one call). No code change.

## 1.0.0

- First release: `init(options)` and `VERSION`. The SDK code is `sequential.js`, the file the script tag loads, with
  the same behaviour: autocapture, session replay, identify, accounts, opt-out (no id or session value stored before
  opt-in or while opted out) and the context cookie `__sq_ctx`.
