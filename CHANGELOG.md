# Changelog

## 1.0.5

- On-screen messages (`$ui_message`) count only what the person can see. A region that is `display:none`,
  `visibility:hidden` or `collapse`, marked `aria-busy="true"` (still loading), or visually hidden (positioned absolutely or
  fixed and at most 1 pixel wide or high, as `.sr-only` classes do) sends nothing, and text inside such a part of a region is
  not read. A loading skeleton announced to screen readers is no longer sent as a message. Styles are read only for a region
  whose text just changed, never for every element on the page.

## 1.0.4

- The person's own pointerup, touchend or keydown is noted on the window, before any handler of the page runs. So a click
  that a page's own key or tap handler makes at once (for example on a `role="button"`) is recorded, also on a browser
  without `navigator.userActivation`, when that handler was added before the SDK.
- On-screen messages (`$ui_message`), off unless the project is switched on by Sequential: for 3 seconds after a click,
  a submit or an Enter, and once 1.5 seconds after a page load or route change, an announced message (`role="alert"`,
  `role="status"`, `aria-live`), a control marked `aria-invalid`, or an error-styled line in a form is sorted into a class
  from the project's patterns. Only the class and structure are sent (kind, tone, the form or section it is near, the
  window, a length band), never the text or any hash of it. Nothing under `data-sq-private` or `data-sq-mask`. At most
  one per message per 10 seconds, 10 per page view and 30 per minute.
- An element id is sent only when it is a plain token (letters, digits, `_` and `-`, at most 128 characters), in
  `$el_id`, the form's `form` and every selector. An id that holds text (a name, an order number, spaces), a generated
  `:r1:` id, or a longer one counts as no id, so the selector is the id-less path. Dead-click and rage-click cases on such
  controls start a new case once, from this release.

## 1.0.3

- A click that a script makes (`el.click()`, `dispatchEvent`; the browser marks it `isTrusted: false`) is recorded only
  while the person acts: while the page has transient user activation, or within 1 second of the person's own
  pointerup, touchend or keydown. So a tap or key that the page forwards as its own click (FastClick on iOS, a key
  handler on a `role="button"`) is still recorded, and a script that clicks on a timer from page load is not: no
  `$click` and no dead click. A browser that does not set `isTrusted` is unchanged.
- At most 5 `$click` per element per second, on a monotonic clock. A faster loop on one element, even with events the
  browser trusts, sends no more. Rage and dead clicks are unchanged.
- A dead click on an option that was already selected carries `$el_state: 'selected'`.

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
