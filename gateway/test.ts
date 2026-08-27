/**
 * Test the AgentCore Gateway MCP endpoint end-to-end.
 *
 * Flow:
 *   1. Read outputs from the API stack (`recipe-catalog`: Cognito token
 *      endpoint, user pool) and the MCP stack (`recipe-catalog-mcp`:
 *      gateway URL, inbound client).
 *   2. Fetch the inbound client secret from the user pool client.
 *   3. Obtain an M2M access token via the Cognito client-credentials flow.
 *   4. Call the MCP endpoint: initialize -> tools/list -> a few tools/call.
 *
 * Usage:
 *   AWS_PROFILE=andmore-sandbox npx tsx gateway/test.ts
 */

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const API_STACK = process.env.API_STACK ?? "recipe-catalog";
const GATEWAY_STACK = process.env.GATEWAY_STACK ?? "recipe-catalog-mcp";
const SCOPE = "recipe-api/invoke";

const cfn = new CloudFormationClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

interface Outputs {
  GatewayUrl: string;
  CognitoTokenEndpoint: string;
  InboundClientId: string;
  UserPoolId: string;
}

async function stackOutputs(stackName: string): Promise<Record<string, string>> {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  const map: Record<string, string> = {};
  for (const o of outputs) {
    if (o.OutputKey && o.OutputValue) map[o.OutputKey] = o.OutputValue;
  }
  return map;
}

async function getOutputs(): Promise<Outputs> {
  // Gateway URL + inbound client come from the MCP stack; the Cognito token
  // endpoint + user pool come from the API stack.
  const [gateway, api] = await Promise.all([
    stackOutputs(GATEWAY_STACK),
    stackOutputs(API_STACK),
  ]);
  const map: Record<string, string> = {
    GatewayUrl: gateway.GatewayUrl,
    InboundClientId: gateway.InboundClientId,
    CognitoTokenEndpoint: api.CognitoTokenEndpoint,
    UserPoolId: api.UserPoolId,
  };
  for (const [key, value] of Object.entries(map)) {
    if (!value) throw new Error(`Missing stack output: ${key}`);
  }
  return map as unknown as Outputs;
}

async function getClientSecret(userPoolId: string, clientId: string): Promise<string> {
  const res = await cognito.send(
    new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId })
  );
  const secret = res.UserPoolClient?.ClientSecret;
  if (!secret) throw new Error("Inbound client has no secret");
  return secret;
}

async function getAccessToken(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: SCOPE,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

let rpcId = 1;
async function mcp(gatewayUrl: string, token: string, method: string, params?: unknown) {
  const res = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP ${method} failed (${res.status}): ${text}`);
  }
  // The gateway may respond with SSE-framed JSON; extract the JSON payload.
  const jsonLine = text
    .split("\n")
    .map((l) => l.replace(/^data:\s*/, "").trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  return JSON.parse(jsonLine ?? text);
}

async function main() {
  console.log(`Reading outputs from stacks: ${API_STACK}, ${GATEWAY_STACK}\n`);
  const outputs = await getOutputs();

  console.log("Fetching inbound client secret...");
  const secret = await getClientSecret(outputs.UserPoolId, outputs.InboundClientId);

  console.log("Obtaining M2M access token...");
  const token = await getAccessToken(outputs.CognitoTokenEndpoint, outputs.InboundClientId, secret);
  console.log("  ✓ token acquired\n");

  console.log(`MCP endpoint: ${outputs.GatewayUrl}\n`);

  // initialize
  const init = await mcp(outputs.GatewayUrl, token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "recipe-catalog-test", version: "1.0.0" },
  });
  console.log("initialize:", JSON.stringify(init.result?.serverInfo ?? init, null, 2));

  // tools/list — should list tools from all three targets
  const tools = await mcp(outputs.GatewayUrl, token, "tools/list");
  const toolNames = (tools.result?.tools ?? []).map((t: any) => t.name);
  console.log(`\ntools/list (${toolNames.length} tools):`);
  for (const name of toolNames) console.log(`  - ${name}`);

  // tools/call — exercise the Lambda target's search_recipes tool.
  // Tool names are prefixed with the target name + "___".
  const searchTool = toolNames.find((n: string) => n.endsWith("search_recipes"));
  if (searchTool) {
    console.log(`\ntools/call ${searchTool} { query: "something spicy with chicken" }`);
    const result = await mcp(outputs.GatewayUrl, token, "tools/call", {
      name: searchTool,
      arguments: { query: "something spicy with chicken" },
    });
    console.log(JSON.stringify(result.result ?? result, null, 2).slice(0, 1200));
  }

  console.log("\n✅ Gateway MCP test complete.");
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message ?? err);
  process.exit(1);
});
