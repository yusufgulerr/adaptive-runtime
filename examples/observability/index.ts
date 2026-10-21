import { runObservabilityExample } from "./metrics.js";

await runObservabilityExample({ logger: (line) => console.log(line) });
