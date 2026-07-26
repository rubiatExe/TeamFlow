import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI, SchemaType, type Content, type FunctionCall, type Tool } from '@google/generative-ai';

type AgentRequest = {
  candidateId?: string;
  roleId?: string;
  merchantId?: string;
  instructions?: string;
  score?: number;
  analysis?: Record<string, unknown>;
  summary?: string;
  redFlags?: string[];
};

type GeminiFunctionCall = FunctionCall & {
  args: Record<string, unknown>;
};

type McpJsonRpcResponse = {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    [key: string]: unknown;
  };
  error?: { message?: string };
};

const apiKey = process.env.GOOGLE_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:8001/mcp';
const AGENT_MODEL = 'gemini-1.5-pro';
const MCP_PROTOCOL_VERSION = '2024-11-05';

const tools: Tool[] = [
  {
    functionDeclarations: [
      {
        name: 'get_job_requirements',
        description: 'Fetch dealbreakers, skills, wage range, and role details for a job role.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            role_id: { type: SchemaType.STRING, description: 'The job role id to fetch.' },
          },
          required: ['role_id'],
        },
      },
      {
        name: 'get_candidate',
        description: 'Fetch a candidate profile, resume text, current score, and analysis.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            candidate_id: { type: SchemaType.STRING, description: 'The candidate id to fetch.' },
          },
          required: ['candidate_id'],
        },
      },
      {
        name: 'list_candidates',
        description: 'List candidate summaries for a merchant, optionally filtered by status.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            merchant_id: { type: SchemaType.STRING, description: 'The merchant id to query.' },
            status_filter: { type: SchemaType.STRING, description: 'Optional candidate status filter.' },
          },
          required: ['merchant_id'],
        },
      },
      {
        name: 'update_fit_score',
        description: 'Update a candidate fit score and analysis in Supabase.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            candidate_id: { type: SchemaType.STRING },
            score: { type: SchemaType.NUMBER },
            analysis: {
              type: SchemaType.OBJECT,
              properties: {
                explanation: { type: SchemaType.STRING },
                constraints: { type: SchemaType.NUMBER },
                experience: { type: SchemaType.NUMBER },
                logistics: { type: SchemaType.NUMBER },
              },
            },
            summary: { type: SchemaType.STRING },
            red_flags: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
            },
          },
          required: ['candidate_id', 'score', 'analysis'],
        },
      },
    ],
  },
];

function parseMcpBody(body: string): McpJsonRpcResponse {
  const trimmed = body.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as McpJsonRpcResponse;
  }

  const dataLine = trimmed
    .split('\n')
    .find(line => line.startsWith('data:'));

  if (!dataLine) {
    return { result: { content: [{ type: 'text', text: trimmed }] } };
  }

  return JSON.parse(dataLine.replace(/^data:\s*/, '')) as McpJsonRpcResponse;
}

function normalizeMcpResult(response: McpJsonRpcResponse): unknown {
  if (response.error) {
    throw new Error(response.error.message || 'MCP tool call failed');
  }

  if (response.result?.structuredContent) {
    return response.result.structuredContent;
  }

  const text = response.result?.content?.find(item => item.type === 'text' && item.text)?.text;
  if (!text) {
    return response.result ?? {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callMcpTool(call: GeminiFunctionCall): Promise<unknown> {
  const sessionId = await createMcpSession().catch((error) => {
    console.warn('[MCP Agent Route] MCP initialize failed, trying stateless tool call:', (error as Error).message);
    return null;
  });

  const { response, body } = await postMcpRequest({
    jsonrpc: '2.0',
    id: `teamflow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    method: 'tools/call',
    params: {
      name: call.name,
      arguments: call.args,
    },
  }, sessionId);

  if (!response.ok) {
    throw new Error(`MCP server returned ${response.status}: ${body}`);
  }

  return normalizeMcpResult(parseMcpBody(body));
}

async function postMcpRequest(
  payload: Record<string, unknown>,
  sessionId?: string | null
): Promise<{ response: Response; body: string }> {
  const headers: Record<string, string> = {
    'Accept': 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };

  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  const response = await fetch(MCP_SERVER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  return { response, body };
}

async function createMcpSession(): Promise<string | null> {
  const { response, body } = await postMcpRequest({
    jsonrpc: '2.0',
    id: `teamflow-init-${Date.now()}`,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'teamflow-next-agent',
        version: '1.0.0',
      },
    },
  });

  if (!response.ok) {
    throw new Error(`initialize returned ${response.status}: ${body}`);
  }

  normalizeMcpResult(parseMcpBody(body));

  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) {
    return null;
  }

  await postMcpRequest({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  }, sessionId);

  return sessionId;
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function buildAgentPrompt(body: AgentRequest) {
  return `You are TeamFlow's MCP-backed hiring agent.

Use the available tools to fetch live context before making or updating hiring decisions.
Always call get_job_requirements when roleId is present.
Call get_candidate when candidateId is present.
Call list_candidates when merchantId is present and the request is about a candidate list.
Call update_fit_score only when the request includes candidateId, score, and analysis.

Request context:
${JSON.stringify(body, null, 2)}

Return valid JSON only:
{
  "summary": "short action/result summary",
  "recommendation": "human-readable next step",
  "fit_score": number or null,
  "analysis": {},
  "tool_calls": ["tool names used"]
}`;
}

export async function POST(req: NextRequest) {
  if (!genAI) {
    return NextResponse.json({ error: 'GOOGLE_API_KEY is required for the MCP agent route' }, { status: 500 });
  }

  try {
    const body = await req.json() as AgentRequest;
    const model = genAI.getGenerativeModel({ model: AGENT_MODEL, tools });
    const prompt = buildAgentPrompt(body);

    const firstResult = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools,
    });

    const functionCalls = firstResult.response.functionCalls() as GeminiFunctionCall[] | undefined;
    if (!functionCalls || functionCalls.length === 0) {
      return NextResponse.json(parseJsonResponse(firstResult.response.text()));
    }

    const toolResults = await Promise.all(
      functionCalls.map(async call => ({
        call,
        result: await callMcpTool(call),
      }))
    );

    const finalContents: Content[] = [
      { role: 'user', parts: [{ text: prompt }] },
      {
        role: 'model',
        parts: functionCalls.map(call => ({ functionCall: call })),
      },
      {
        role: 'function',
        parts: toolResults.map(({ call, result }) => ({
          functionResponse: {
            name: call.name,
            response: { result },
          },
        })),
      },
    ];

    const finalResult = await model.generateContent({
      contents: finalContents,
      tools,
      generationConfig: { responseMimeType: 'application/json' },
    });

    return NextResponse.json({
      ...parseJsonResponse(finalResult.response.text()) as Record<string, unknown>,
      tool_results: toolResults.map(({ call, result }) => ({ name: call.name, result })),
    });
  } catch (error) {
    console.error('[MCP Agent Route] Error:', error);
    return NextResponse.json({ error: 'MCP agent route failed', details: (error as Error).message }, { status: 500 });
  }
}
