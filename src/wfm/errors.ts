/** Base class for every failure raised by the warframe.market client. */
export class WfmError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Any non-OK HTTP response that isn't covered by a more specific class. */
export class WfmHttpError extends WfmError {
  constructor(
    readonly status: number,
    url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? ` — ${body.slice(0, 160)}` : ""}`, url);
  }
}

/**
 * A 403 from this API means the route itself is switched off, not that we sent
 * bad credentials. `/v1/.../orders` already answers this way. It is permanent:
 * never retried, and raised loudly so a dead endpoint cannot be mistaken for a
 * blip in a long crawl.
 */
export class WfmEndpointRetiredError extends WfmError {
  constructor(url: string, readonly body: string) {
    super(
      `Endpoint retired (403): ${url}. ` +
        `warframe.market has switched this route off — it will not come back. ` +
        `Body: ${body.slice(0, 120)}`,
      url,
    );
  }
}

/** The item/slug does not exist. Not retried. */
export class WfmNotFoundError extends WfmError {
  constructor(url: string) {
    super(`Not found (404): ${url}`, url);
  }
}

/** Retries exhausted, or the network never answered. */
export class WfmUnavailableError extends WfmError {
  constructor(url: string, readonly attempts: number, readonly cause: unknown) {
    super(
      `Gave up on ${url} after ${attempts} attempt(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      url,
    );
  }
}

/** The response was not the shape we expect (envelope missing, bad JSON). */
export class WfmShapeError extends WfmError {
  constructor(url: string, detail: string) {
    super(`Unexpected response shape from ${url}: ${detail}`, url);
  }
}
