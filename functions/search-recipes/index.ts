import { DynamoDBClient, SearchVectorsCommand } from "@aws-sdk/client-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";

const TABLE_NAME = process.env.TABLE_NAME!;
const EMBEDDING_MODEL_ID = process.env.EMBEDDING_MODEL_ID!;
const INDEX_NAME = "RecipeEmbeddingIndex";
const TOP_K = 5;

const dynamodb = new DynamoDBClient();
const bedrock = new BedrockRuntimeClient();

type InvocationType = "apiGateway" | "agentCoreGateway";

/**
 * Detect the invocation type and extract the tool inputs.
 * - API Gateway (HTTP proxy): inputs come from the JSON request body.
 * - AgentCore Gateway (Lambda target): inputs are a flat object on the event,
 *   and the tool name is set on context.clientContext.custom.bedrockAgentCoreToolName.
 */
function extractInputs(
  event: APIGatewayProxyEvent | Record<string, unknown>,
  context: Context
): { type: InvocationType; hasBody: boolean; query: unknown } {
  if ((context as any)?.clientContext?.custom?.bedrockAgentCoreToolName) {
    // AgentCore Gateway: inputs are a flat object; treat as always "present".
    return { type: "agentCoreGateway", hasBody: true, query: (event as any).query };
  }
  const body = (event as APIGatewayProxyEvent).body;
  return {
    type: "apiGateway",
    hasBody: Boolean(body),
    query: body ? JSON.parse(body).query : undefined,
  };
}

/**
 * Build the response in the shape expected by the invocation type.
 * - API Gateway expects { statusCode, body }.
 * - AgentCore Gateway expects a plain JSON object.
 */
function buildResponse(
  type: InvocationType,
  statusCode: number,
  payload: unknown
): APIGatewayProxyResult | Record<string, unknown> {
  if (type === "agentCoreGateway") {
    return payload as Record<string, unknown>;
  }
  return { statusCode, body: JSON.stringify(payload) };
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: 1024, normalize: true }),
    })
  );
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.embedding;
}

export async function handler(
  event: APIGatewayProxyEvent | Record<string, unknown>,
  context: Context
): Promise<APIGatewayProxyResult | Record<string, unknown>> {
  const { type, hasBody, query } = extractInputs(event, context);

  try {
    if (!hasBody) {
      return buildResponse(type, 400, { error: "Request body is required" });
    }

    if (!query || typeof query !== "string") {
      return buildResponse(type, 400, { error: "query string is required" });
    }

    // Embed the search query
    const queryVector = await generateEmbedding(query);

    // Vector search across all recipes
    const response = await dynamodb.send(
      new SearchVectorsCommand({
        TableName: TABLE_NAME,
        IndexName: INDEX_NAME,
        SearchVector: queryVector.map((v) => ({ N: String(v) })),
        TopK: TOP_K,
      })
    );

    const results = (response.SearchResults ?? []).map((result) => {
      const item = result.Item!;
      // Convert cosine distance (0=identical, 2=opposite) to similarity percentage
      const similarity = Math.round((1 - (result.Score ?? 1)) * 100) / 100;
      return {
        recipeId: item.recipeId?.S,
        name: item.name?.S,
        cuisine: item.cuisine?.S,
        description: item.description?.S,
        dietary: item.dietary?.L?.map((d) => d.S).filter(Boolean) ?? [],
        prepTimeMinutes: item.prepTimeMinutes?.N ? Number(item.prepTimeMinutes.N) : null,
        cookTimeMinutes: item.cookTimeMinutes?.N ? Number(item.cookTimeMinutes.N) : null,
        servings: item.servings?.N ? Number(item.servings.N) : null,
        similarity,
      };
    });

    return buildResponse(type, 200, { query, results });
  } catch (error: any) {
    console.error("Error searching recipes:", error);
    return buildResponse(type, 500, { error: error.message });
  }
}
