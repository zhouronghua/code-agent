/*---------------------------------------------------------------------------------------------
 *  Integration check against the REAL gateway (evidence for the fix, not a CI test).
 *
 *  Replays the conversation that killed session_1789532661667_963lth: it was saved
 *  AFTER a 保底-model recovery had dropped every reasoning_content, so its history is
 *  exactly the shape that api.enflame.cn rejects with
 *    "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 *  Run:
 *    npx esbuild tests/verify-reasoning-echo.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=/tmp/verify-reasoning-echo.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/verify-reasoning-echo.mjs <session.json> <api-base> <api-key> <model>
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { OpenAIProvider } from 'vs/workbench/services/agent/browser/llmOpenai';
import { IAgentConfig, IAgentMessage, MessageRole } from 'vs/workbench/services/agent/common/agentModels';

const [sessionPath, apiBase, apiKey, model] = process.argv.slice(2);

function toMessages(session: { systemPrompt?: string; messages: any[] }): IAgentMessage[] {
	const out: IAgentMessage[] = [{
		id: 'sys', role: MessageRole.System, content: session.systemPrompt || 'system', timestamp: 0,
	}];
	session.messages.forEach((m, i) => {
		out.push({
			id: `m${i}`,
			role: m.role as MessageRole,
			content: m.content || '',
			timestamp: i,
			toolCalls: m.toolCalls,
			toolCallId: m.toolCallId,
		});
	});
	return out;
}

function config(): IAgentConfig {
	return {
		provider: 'openai', model, apiKey, apiBase,
		maxSteps: 1, maxContextTokens: 1_048_576, maxOutputTokens: 393_216,
		temperature: 0, stepTimeout: 300_000, taskTimeout: 600_000,
	};
}

async function main(): Promise<void> {
	const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
	const messages = toMessages(session);
	const assistants = messages.filter(m => m.role === MessageRole.Assistant);
	const withReasoning = assistants.filter(m => m.reasoningContent);
	console.log(`history: ${messages.length} messages, ${assistants.length} assistant, ` +
		`${withReasoning.length} carrying reasoning_content`);
	console.log(`tail: ${messages[messages.length - 1].role} (tool-calls pending: ` +
		`${messages[messages.length - 1].role === MessageRole.Tool})`);
	console.log(`last assistant has toolCalls: ${!!messages[messages.length - 2].toolCalls}`);

	// (a) fresh provider, no prior evidence of thinking mode → must self-heal
	const fresh = new OpenAIProvider(config());
	const t0 = Date.now();
	const reply = await fresh.complete(messages);
	console.log(`(a) fresh provider: OK in ${Date.now() - t0}ms — ` +
		`supportsReasoning=${fresh.supportsReasoning()}, content=${JSON.stringify((reply.content || '').slice(0, 60))}`);

	// (b) provider that already saw reasoning_content → no repair round-trip
	const warm = new OpenAIProvider(config());
	await warm.complete([{ id: 'u', role: MessageRole.User, content: 'say hi in 3 words', timestamp: 0 }]);
	console.log(`(b) warm provider: supportsReasoning=${warm.supportsReasoning()}`);
	const t1 = Date.now();
	const reply2 = await warm.complete(messages);
	console.log(`(b) warm provider: OK in ${Date.now() - t1}ms — content=${JSON.stringify((reply2.content || '').slice(0, 60))}`);
}

void main().catch(err => {
	console.error('FAILED:', (err as Error).message);
	process.exit(1);
});
