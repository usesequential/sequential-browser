// Types for @usesequential/browser. The methods are those of the script tag's `window.sequential`
// (https://www.usesequential.com/docs/sequential).

export interface InitOptions {
  /** The project's `sequential` ingest key, `sq_sequential_…`, from Setup. Required. */
  key: string;
  /** The ingest host, such as `https://api.usesequential.com`. Required. */
  api: string;
  /** Your app's build, sent as `$release` on every event: 1 to 64 printable ASCII characters. */
  release?: string;
  /** Start opted out, as the tag's `data-opt-out`: nothing is sent and nothing is stored until `optIn()`. */
  optOut?: boolean;
  /** `false` turns off automatic page views, clicks and form submits, as `data-autocapture="false"`. */
  autocapture?: boolean;
  /** `false` turns off the check that keeps the signed-in person's name and email out of click text, as
   *  `data-identity-text="off"`. */
  identityText?: boolean;
  /** `Domain=` for the context cookie `__sq_ctx`, as `data-context-cookie-domain`. */
  contextCookieDomain?: string;
}

export interface Sequential {
  /** Sends a custom event. Names that start with `$` are reserved and throw. */
  capture(event: string, props?: Record<string, unknown>): void;
  /** Names the person. Changed properties send a new `$identify` event. */
  identify(distinctId: string, props?: Record<string, unknown>): void;
  /** B2B: the account (company, workspace) this person acts for. Every later event carries its id. */
  account(id: string | number, traits?: Record<string, unknown>): void;
  /** Properties added to every later event of this page load. */
  register(props: Record<string, unknown>): void;
  unregister(propKey: string): void;
  /** A new anonymous visitor and session, for example at sign-out. */
  reset(): void;
  /** Stops analytics and session replay, deletes the stored ids, and keeps the `__sq_opt` choice. */
  optOut(): void;
  /** Deletes the `__sq_opt` choice and starts recording. */
  optIn(): void;
  captureException(error: unknown, props?: Record<string, unknown>): void;
  /** Sends the queued events now. */
  flush(): Promise<void>;
}

/** Starts the SDK once and returns it. Without a window (server rendering), or without `key` and `api`, it returns an
 *  object whose methods do nothing. A second call, or a page where the script tag already loaded the SDK, returns the
 *  running instance. */
export declare function init(options: InitOptions): Sequential;

/** This package's version. */
export declare const VERSION: string;
