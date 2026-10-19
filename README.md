# @usesequential/browser

The [Sequential](https://www.usesequential.com) browser SDK as an npm package: product analytics and session replay
from one call. The code is `sequential.js`, the file that the Sequential script tag loads, with the same behaviour.

- Page views, clicks, form submits, rage clicks and dead clicks, recorded automatically.
- Session replay, when replay is on for your project. The SDK loads the recorder from your ingest host.
- `identify`, `account`, custom events and errors.
- Consent: start opted out, and nothing is stored on the device until `optIn()`.
- No dependencies. ES modules and CommonJS. Types included. Safe to import in server-rendered apps.

## Install

```bash
npm install @usesequential/browser
```

Copy the project's **sequential** key (`sq_sequential_…`) and the API host from **Setup** in Sequential.

## Start it

Call `init()` once, in the browser, as early as you can:

```ts
import { init } from '@usesequential/browser';

const sequential = init({
  key: 'sq_sequential_…',
  api: 'https://api.usesequential.com',
  release: 'web@2.14.1', // optional: your app's build, on every event
});

sequential.identify(user.id, { email: user.email });
sequential.capture('checkout_started', { plan: 'pro' });
```

`init()` also sets `window.sequential`, the same object, so code written for the script tag works.

- **Server rendering.** Importing the package does nothing. Without a window, `init()` returns an object whose
  methods do nothing. Call it from client code: in SvelteKit in `onMount` or a `+layout.svelte` browser block, in
  Next.js in a client component's `useEffect`.
- **Call it once.** A second `init()` returns the running SDK and writes a warning to the console.
- **Not with the script tag.** Use the package or the tag, not both. If the tag already loaded the SDK, `init()`
  returns that SDK and does not read its options. If the tag's install snippet ran first, `init()` sends the calls
  that it queued.

## Options

| Option | Same as the tag's | |
|---|---|---|
| `key` | `data-key` | Required. |
| `api` | `data-api` | Required. |
| `release` | `data-release` | 1 to 64 printable ASCII characters. |
| `optOut: true` | `data-opt-out` | Start opted out. |
| `autocapture: false` | `data-autocapture="false"` | No automatic page views, clicks or form submits. |
| `identityText: false` | `data-identity-text="off"` | No check for the signed-in person's name and email in click text. |
| `contextCookieDomain` | `data-context-cookie-domain` | `Domain=` for the context cookie `__sq_ctx`. |

Without `key` and `api`, `init()` writes one error to the console and sends nothing.

## Consent

For a site that waits for consent, start opted out and call `optIn()` when the visitor agrees:

```ts
const sequential = init({ key: 'sq_sequential_…', api: 'https://api.usesequential.com', optOut: true });
consentBanner.onAccept(() => sequential.optIn());
```

Before opt-in, and while a visitor is opted out, the SDK stores no id, no session value and no cookie on the device.
With `optOut: true`, it stores nothing at all. `optOut()` deletes the ids that the SDK stored and keeps one key,
`__sq_opt`, that holds only the visitor's choice, so the opt-out stays in force on the next pages. `optIn()` deletes
it.

## Methods

`capture(name, props)`, `identify(userId, props)`, `account(id, traits)`, `register(props)`, `unregister(name)`,
`reset()`, `optOut()`, `optIn()`, `captureException(error, props)` and `flush()`. Names that start with `$` are
reserved, and `capture()` throws on them.

Full documentation: https://www.usesequential.com/docs/browser-npm and https://www.usesequential.com/docs/sequential.

## Licence

MIT
