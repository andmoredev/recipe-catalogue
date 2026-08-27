import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";

const TABLE_NAME = process.env.TABLE_NAME!;
const dynamodb = new DynamoDBClient();

type InvocationType = "apiGateway" | "agentCoreGateway";

/**
 * Detect the invocation type and extract the tool inputs.
 * - API Gateway (HTTP proxy): recipeId comes from the path parameters.
 * - AgentCore Gateway (Lambda target): recipeId is a flat field on the event,
 *   and the tool name is set on context.clientContext.custom.bedrockAgentCoreToolName.
 */
function extractInputs(
  event: APIGatewayProxyEvent | Record<string, unknown>,
  context: Context
): { type: InvocationType; recipeId: string | undefined } {
  if ((context as any)?.clientContext?.custom?.bedrockAgentCoreToolName) {
    return { type: "agentCoreGateway", recipeId: (event as any).recipeId };
  }
  return {
    type: "apiGateway",
    recipeId: (event as APIGatewayProxyEvent).pathParameters?.recipeId,
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

export async function handler(
  event: APIGatewayProxyEvent | Record<string, unknown>,
  context: Context
): Promise<APIGatewayProxyResult | Record<string, unknown>> {
  const { type, recipeId } = extractInputs(event, context);

  try {
    if (!recipeId) {
      return buildResponse(type, 400, { error: "recipeId is required" });
    }

    const result = await dynamodb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { recipeId: { S: recipeId } },
      })
    );

    if (!result.Item) {
      return buildResponse(type, 404, { error: "Recipe not found" });
    }

    const recipe = unmarshall(result.Item);
    // Remove the embedding from the response — it's internal
    delete recipe.embedding;

    return buildResponse(type, 200, recipe);
  } catch (error: any) {
    console.error("Error getting recipe:", error);
    return buildResponse(type, 500, { error: error.message });
  }
}
