import { runEdgeGatewayExample } from "./edge-gateway.js";

await runEdgeGatewayExample({ logger: (line) => console.log(line) });
