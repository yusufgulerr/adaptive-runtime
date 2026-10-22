# ADR 0007: Multi-runtime web and edge providers, and composite signals

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project maintainers

## Context

The runtime was originally documented and packaged as Node.js-only. The policy
core, signal collector, executor, and error model were already free of Node.js
APIs, but the package exposed a single root entry point that re-exported the
process providers. Applications running in browsers, Cloudflare Workers, Vercel
Edge, Deno, Bun, or short-lived serverless functions had no supported way to use
the runtime, and a bundler could not prove that Node.js built-ins were absent.

Three pressure sources are common outside Node.js:

- browser tab/device memory and JavaScript heap limits;
- network information such as RTT, downlink, and data-saver mode;
- render-loop frame duration and dropped-frame ratio;
- serverless wall-clock deadlines and in-flight concurrency.

The constraints were:

- no runtime dependencies and no DOM type-library requirement;
- no Node.js built-ins in the portable core, web, edge, policy, observability,
  or testing modules;
- explicit unavailable statuses; never coerce missing data to `0`;
- deterministic policy behavior and stable CI job names;
- existing Node.js consumers keep the root entry point.

## Decision

### Platform-targeted entry points

Add `src/core.ts`, `src/node.ts`, `src/web.ts`, and `src/edge.ts`, exported as
`adaptive-runtime/core`, `/node`, `/web`, and `/edge`. The root
(`adaptive-runtime`) re-exports the Node.js entry point for backward
compatibility. Each platform entry point re-exports the portable core and adds
only its own providers. `adaptive-runtime/providers` remains a mixed barrel for
callers that explicitly want every provider; it is documented as not
platform-neutral.

`src/index.ts` delegates to `src/node.ts`. The published `package.json` declares
`types`, `import`, and `default` conditions for every subpath.

### Structural web providers

Add `DeviceMemoryProvider`, `NetworkInformationProvider`, and
`FrameTimingProvider` under `src/providers/web/`. They use structural interfaces
(`MemoryInfoLike`, `NetworkInformationLike`, etc.) and read `globalThis` with
optional chaining, so they compile without the DOM library. Each provider has an
injection point for tests and custom runtimes. Unsupported APIs return
`unsupported`; invalid values return `unknown` or `error`; no provider returns
`0` for absent data.

`FrameTimingProvider` is fed by the application render loop through
`recordFrameDuration(ms)`. It keeps a bounded sliding window, reports a nearest-
rank P95 duration, and reports the ratio of frames above the target budget.
Invalid durations throw `ConfigurationError`; too few samples produce `unknown`.

### Edge execution budget provider

Add `ExecutionBudgetProvider` under `src/providers/edge/`. It takes an
application-supplied `getBudgetSnapshot` function, which may be async and
receives the provider abort signal. It exposes remaining wall-clock time, used
ratio, and concurrency saturation. Missing fields are `unknown`; invalid fields
are `error`. The provider does not read platform-specific deadline APIs because
those differ across Workers, Lambda, Deno Deploy, and Node.js.

### Composite signals

Add `CompositeSignalProvider` to the portable core. It wraps one or more
providers, optionally passes through their readings, and derives new readings
from declared input names. The constructor rejects empty provider/rule lists,
unknown inputs, duplicate rule names, and collisions with passthrough names.
Reads run children with `Promise.all`; a rule computes only when every input is
`ok`. Otherwise the composite propagates `error` > `stale` > `unsupported` >
`unknown` and never calls `compute`. A compute throw or non-finite result becomes
an `error` reading. `start()` and `close()` are forwarded to children.

### Portability enforcement

Add a source-scan test over the portable module set. It fails if any file
contains a Node.js built-in import or reads the Node.js `process` object. Add
integration tests that import every package entry point and assert platform
isolation, plus a clean-consumer check of the packed tarball.

## Consequences

Positive:

- One deterministic runtime now serves Node.js, browsers, and WinterCG
  runtimes.
- Bundlers can import platform-specific entry points without Node.js shims.
- Composite signals let applications express policy pressure without duplicating
  provider logic.
- Missing platform APIs remain explicit and observable.
- Existing root imports continue to work.

Negative:

- More public entry points and more integration tests to maintain.
- The mixed `/providers` barrel can accidentally pull Node.js code into a web
  bundle if an application chooses it instead of `/core` or `/web`.
- Web and edge providers depend on runtime-specific globals that may be absent or
  partially implemented; callers must check statuses rather than assume values.
- The edge provider requires application wiring for deadline and concurrency
  snapshots.
- Composite providers add a second read fan-out; child providers must be cheap
  and bounded.

## Alternatives considered

- **Keep the runtime Node.js-only:** rejects the stated multi-runtime goal and
  leaves browser/edge users with unsupported workarounds. Rejected.
- **Bundle DOM type definitions in the package:** forces a DOM lib and can
  conflict with worker or server configurations. Structural interfaces and
  optional injection are smaller and more portable.
- **Detect platform-specific deadline APIs automatically:** APIs differ across
  vendors and are not reliably exposed. An application snapshot is explicit and
  testable.
- **Compute composite signals inside the policy engine:** couples measurement to
  selection and makes arbitrary derived metrics part of the policy contract.
  A provider keeps the policy engine pure and the signal reusable.
- **Use `0` for unavailable web/edge data:** recreates the zero-coercion bug and
  makes missing telemetry look healthy. Rejected.

## Follow-up

- Keep `src/core.ts`, `src/web.ts`, `src/edge.ts`, `src/policy/**`,
  `src/runtime/**`, `src/signals/**`, `src/errors/**`, `src/types/**`,
  `src/observability/**`, `src/testing/**`, `src/providers/web/**`,
  `src/providers/edge/**`, and `src/providers/composite.ts` free of Node.js
  built-ins and `process` access.
- Document signal units, injection points, and unavailable-status behavior in
  the provider guide.
- Maintain the clean-consumer subpath check after packaging changes.
- Revisit platform-specific deadline hooks only if a stable cross-vendor
  interface emerges.
