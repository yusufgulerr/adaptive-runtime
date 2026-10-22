# Multi-runtime edge gateway example

A deterministic example that uses only the platform-neutral core, the edge
execution-budget provider, and the observability bridge:

- `adaptive-runtime/core`
- `adaptive-runtime/edge`
- `adaptive-runtime/observability`

It models an edge gateway with a three-tier strategy ladder
(`deep-rerank`, `fast-vector`, `cached-lexical`), a scripted execution-budget
snapshot, and a composite `edge.pressure.score` signal. The signal combines
remaining budget, used budget ratio, and concurrency saturation. The runtime
adapts through explicit budgets, candidate filtering, and hysteresis.

Run it from the repository root:

```bash
npm run example:edge
```

Expected strategy sequence:

```text
deep-rerank, deep-rerank, fast-vector, cached-lexical, deep-rerank
```

The script prints per-request decision metadata and Prometheus text, including
`edge_gateway_runs_total`, `edge_gateway_signal_reading`,
`edge_gateway_strategy_selections_total`, the latest `edge.pressure.score`
gauge, and `edge_gateway_runtime_closed_total`.

The example uses a fixed clock and scripted snapshots, so it does not require a
browser, a server, or a specific edge vendor. It is a documentation and
integration example, not a production gateway.
