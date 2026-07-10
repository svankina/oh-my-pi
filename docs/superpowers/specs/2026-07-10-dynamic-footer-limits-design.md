# Dynamic Footer Limits Design

## Summary

The active omp footer must show live usage limits for the selected model and the exact OAuth subscription account serving the session. Changing the model, provider, or routed subscription account must immediately remove the previous limits and refresh the applicable limits.

The implementation will make the existing status-line `usage` segment provider-independent. It will project normalized `UsageReport` data onto the current session instead of taking the first Anthropic-shaped `5h` and `7d` limits returned across all accounts.

## Problem

The interactive TUI uses `StatusLineComponent` from `packages/coding-agent/src/modes/components/status-line/component.ts`. The exported `FooterComponent` in `packages/coding-agent/src/modes/components/footer.ts` is legacy code and has no internal runtime caller.

`StatusLineComponent` currently fetches usage reports for every authenticated provider and account, then caches the first untiered `5h` and `7d` limits it encounters. The normalization does not inspect:

- the selected model's provider;
- the selected model ID;
- the OAuth account routed to the session;
- account identity in report metadata or limit scope;
- arbitrary provider window names or durations.

The five-minute cache is also global to the component. A model or credential switch can therefore leave limits from the previous provider or account visible.

## Goals

- Show limits only for the selected model's provider.
- Show limits only for the session-sticky OAuth account currently serving requests.
- Include account-wide/provider-wide limits and limits scoped to the selected model.
- Support every normalized usage window rather than hard-coded `5h` and `7d` fields.
- Clear stale limits immediately when the model, provider, or active account changes.
- Preserve non-blocking rendering, the two-second startup timeout, late-result handling, and the five-minute refresh TTL.
- Reuse normalized usage and active-account matching APIs already present in the repository.

## Non-goals

- Do not aggregate quota across multiple subscription accounts.
- Do not display limits for API-key credentials.
- Do not add the `usage` segment to built-in presets that do not already include it.
- Do not change the `/usage` command, usage history, credential rotation, or provider usage fetchers.
- Do not modify the legacy `FooterComponent`.
- Do not add provider-specific Claude, Codex, Gemini, or future-provider branches.

## Selected Session

The status line derives a selection key from the current session:

1. Read the selected model from `session.state.model`, falling back to `session.model` only where the status line already does so.
2. Use the model's `provider` and `id`.
3. Confirm that `session.modelRegistry.isUsingOAuth(model)` is true.
4. Resolve the session-sticky OAuth identity with `session.modelRegistry.authStorage.getOAuthAccountIdentity(provider, sessionId)`.
5. Canonicalize the available `accountId`, `email`, and `projectId` fields into the key.

If the model is absent, the selected credential is not OAuth, or no active OAuth identity is available, the usage selection is unavailable. The segment clears its cached display and stays hidden.

The session ID must be the same value used by model credential routing. The implementation must use the existing public `AgentSession`/session-manager accessor rather than introducing a second identity source.

## Usage Projection

A pure projection function will transform fetched `UsageReport[]` into footer limits for one selection key. Keeping this logic pure makes provider, model, account, and window behavior directly testable.

For each report and limit:

1. Keep reports whose `report.provider` equals the selected model provider.
2. Keep only limits that match the active OAuth identity through the existing `limitMatchesActiveAccount(report, limit, identity)` helper.
3. Keep a limit when `limit.scope.modelId` is absent or equals the selected model ID.
4. Exclude limits scoped to a different model, even when they belong to the same provider and account.
5. Resolve consumption with `resolveUsedFraction(limit)`. Exclude limits whose used fraction cannot be resolved.
6. Clamp only the displayed percentage to the valid visual range; retain the normalized fraction for status/color decisions so exhausted or over-limit values remain errors.
7. Preserve provider report/limit order and remove duplicate stable limit IDs within the selected account.

An account-wide or shared limit remains eligible when it has no `modelId`, provided its report or scope still matches the active OAuth identity. Accountless reports are not used as a fallback: hiding unverifiable data is safer than showing another account's quota.

## Footer Limit Shape

The status-line context will replace the fixed `{ fiveHour, sevenDay }` structure with an ordered list. Each item contains only rendering data:

```ts
interface StatusLineUsageLimit {
  id: string;
  label: string;
  usedFraction: number;
  resetsAt?: number;
  tier?: string;
  modelId?: string;
}
```

The label prefers the normalized window label, then the limit label. A tier or model qualifier is appended only when two visible limits would otherwise have the same label. This keeps ordinary output compact while making ambiguous windows distinguishable.

Examples:

```text
5h 42% (1h 12m) · 7d 68% (4d 3h)
Daily 18% (9h) · Monthly 54% (21d)
Requests (Pro) 72% (3h) · Requests (Standard) 14% (3h)
```

Reset times are calculated from `window.resetsAt` at render time so the countdown continues to age while the report remains cached. Missing reset timestamps omit the parenthetical reset text.

## Cache and Refresh Lifecycle

`StatusLineComponent` will cache both the selection key and the projected limits.

On each usage-enabled render:

1. Resolve the current selection key.
2. If no key exists, clear cached limits and do not fetch.
3. If the key differs from the cached or in-flight key, clear visible limits immediately, reset the TTL, and schedule a background fetch for the new key.
4. If the key is unchanged and the cached result is younger than five minutes, reuse it.
5. If the key is unchanged and stale, schedule a refresh while retaining the stale value until the refresh completes.

Fetches retain the existing zero-delay deferred start and two-second timeout signal. A response that resolves after the timeout may still update the cache only when its captured selection key still equals the current key. Results from a previous model, provider, account, or disposed component are discarded.

An empty successful projection is cached for the normal five-minute TTL to avoid repeated provider requests on every render.

## Rendering

The `usage` status-line segment will render every projected limit:

- percentage rounded to the nearest whole number;
- warning color at 50% or more;
- error color at 80% or more;
- existing muted styling below 50%;
- relative reset duration when supplied;
- existing segment icon and separator conventions.

The segment remains invisible when the projected list is empty. Existing status-line truncation handles narrow terminals. Built-in preset membership and user custom status-line settings remain unchanged.

## Error Handling

- Fetch rejection or timeout must not block or throw from rendering.
- A failed refresh records the refresh attempt for TTL/backoff behavior and retains stale data only for the same selection key.
- A failed refresh after a selection change leaves the segment hidden; it must not restore old limits.
- Malformed reports, limits without a resolvable used fraction, and unverifiable account identities are ignored.
- Disposal cancels pending timers and prevents late asynchronous writes or redraw callbacks.

## Tests

Focused tests will cover observable behavior:

1. The selected provider's limits render while another provider's limits do not.
2. The active OAuth account's limits render while sibling subscription accounts do not.
3. Changing the active account clears the old values and triggers a refresh.
4. Changing the model/provider clears the old values and triggers a refresh despite the five-minute TTL.
5. Account-wide limits and selected-model limits render together; other-model limits do not.
6. Arbitrary daily/monthly window labels render without `5h`/`7d` assumptions.
7. Duplicate stable limit IDs are rendered once.
8. API-key models, missing identities, empty reports, and unusable limits hide the segment.
9. A late result applies for the same selection key after timeout.
10. A late result for an obsolete selection key is discarded.
11. Existing non-blocking fetch, timeout, backoff, and disposal tests continue to pass.

The focused command is:

```sh
bun test packages/coding-agent/test/status-line-usage-refresh.test.ts
```

Any extracted pure projection helper receives a dedicated test file when that produces clearer boundary tests than exercising private component state.

## Acceptance Criteria

- With a Claude subscription model selected, the footer never shows Codex, Gemini, or another Claude account's limits.
- With a Codex subscription model selected, the footer never shows the previously selected Claude limits.
- Credential rotation within one provider replaces the previous account's limits on the next render/refresh cycle.
- Providers with non-`5h`/`7d` windows display their normalized window labels and percentages.
- API-key models and providers without verifiable live usage data show no usage segment.
- Rendering remains synchronous and non-blocking.
- Focused status-line usage tests pass without warnings or unhandled asynchronous work.
